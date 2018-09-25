// Copyright 2018 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as process from 'process';
import * as prometheus from 'prom-client';
import * as restify from 'restify';

import {FilesystemTextFile} from '../infrastructure/filesystem_text_file';
import * as ip_location from '../infrastructure/ip_location';
import * as json_config from '../infrastructure/json_config';
import * as logging from '../infrastructure/logging';
import {PrometheusClient, runPrometheusScraper} from '../infrastructure/prometheus_scraper';

import {createShadowsocksMetrics} from './libev_shadowsocks_server';
import {ManagerMetrics, ManagerMetricsJson} from './manager_metrics';
import {bindService, ShadowsocksManagerService} from './manager_service';
import {createServerAccessKeyRepository} from './server_access_key';
import * as server_config from './server_config';
import {SharedMetrics, SharedMetricsJson} from './shared_metrics';

const DEFAULT_STATE_DIR = '/root/shadowbox/persisted-state';
const MAX_STATS_FILE_AGE_MS = 5000;

// Serialized format for the metrics file.
// WARNING: Renaming fields will break backwards-compatibility.
interface MetricsConfigJson {
  // Serialized ManagerStats object.
  transferStats?: ManagerMetricsJson;
  // Serialized SharedStats object.
  hourlyMetrics?: SharedMetricsJson;
}

function readMetricsConfig(filename: string): json_config.JsonConfig<MetricsConfigJson> {
  try {
    const metricsConfig = json_config.loadFileConfig<MetricsConfigJson>(filename);
    // Make sure we have non-empty sub-configs.
    metricsConfig.data().transferStats =
        metricsConfig.data().transferStats || {} as ManagerMetricsJson;
    metricsConfig.data().hourlyMetrics =
        metricsConfig.data().hourlyMetrics || {} as SharedMetricsJson;
    return new json_config.DelayedConfig(metricsConfig, MAX_STATS_FILE_AGE_MS);
  } catch (error) {
    throw new Error(`Failed to read metrics config at ${filename}: ${error}`);
  }
}

async function exportPrometheusMetrics(registry: prometheus.Registry): Promise<string> {
  const localMetricsServer = await new Promise<http.Server>((resolve, _) => {
    const server = http.createServer((_, res) => {
      res.write(registry.metrics());
      res.end();
    });
    server.on('listening', () => {
      resolve(server);
    });
    server.listen({port: 0, host: 'localhost', exclusive: true});
  });
  return `localhost:${localMetricsServer.address().port}`;
}

async function main() {
  const verbose = process.env.LOG_LEVEL === 'debug';
  prometheus.collectDefaultMetrics({register: prometheus.register});
  const nodeMetricsLocation = await exportPrometheusMetrics(prometheus.register);
  logging.debug(`Node metrics is at ${nodeMetricsLocation}`);

  const proxyHostname = process.env.SB_PUBLIC_IP;
  // Default to production metrics, as some old Docker images may not have
  // SB_METRICS_URL properly set.
  const metricsUrl = process.env.SB_METRICS_URL || 'https://metrics-prod.uproxy.org';
  if (!process.env.SB_METRICS_URL) {
    logging.warn('process.env.SB_METRICS_URL not set, using default');
  }

  if (!proxyHostname) {
    throw new Error('Need to specify SB_PUBLIC_IP for invite links');
  }

  logging.debug(`=== Config ===`);
  logging.debug(`SB_PUBLIC_IP: ${proxyHostname}`);
  logging.debug(`SB_METRICS_URL: ${metricsUrl}`);
  logging.debug(`==============`);

  const DEFAULT_PORT = 8081;
  const portNumber = Number(process.env.SB_API_PORT || DEFAULT_PORT);
  if (isNaN(portNumber)) {
    throw new Error(`Invalid SB_API_PORT: ${process.env.SB_API_PORT}`);
  }

  const prometheusMetricsLocation = 'localhost:9090';
  runPrometheusScraper(
      [
        '--storage.tsdb.retention', '31d', '--storage.tsdb.path',
        getPersistentFilename('prometheus/data'), '--web.listen-address', prometheusMetricsLocation,
        '--log.level', verbose ? 'debug' : 'info'
      ],
      getPersistentFilename('prometheus/config.yml'), {
        global: {
          scrape_interval: '15s',
        },
        scrape_configs: [
          {job_name: 'prometheus', static_configs: [{targets: [prometheusMetricsLocation]}]},
          {job_name: 'outline-server', static_configs: [{targets: [nodeMetricsLocation]}]}
        ]
      });

  const serverConfig =
      server_config.readServerConfig(getPersistentFilename('shadowbox_server_config.json'));

  const metricsConfig = readMetricsConfig(getPersistentFilename('shadowbox_stats.json'));
  const managerMetrics = new ManagerMetrics(
      new PrometheusClient(`http://${prometheusMetricsLocation}`),
      new json_config.ChildConfig(metricsConfig, metricsConfig.data().transferStats));
  const sharedMetrics = new SharedMetrics(
      new json_config.ChildConfig(metricsConfig, metricsConfig.data().hourlyMetrics), serverConfig,
      metricsUrl, new ip_location.MmdbLocationService());

  logging.info('Starting...');
  const userConfigFilename = getPersistentFilename('shadowbox_config.json');
  createServerAccessKeyRepository(
      proxyHostname, new FilesystemTextFile(userConfigFilename),
      createShadowsocksMetrics(prometheus.register), verbose)
      .then((accessKeyRepository) => {
        const managerService = new ShadowsocksManagerService(
            process.env.SB_DEFAULT_SERVER_NAME || 'Outline Server', serverConfig,
            accessKeyRepository, managerMetrics);
        const certificateFilename = process.env.SB_CERTIFICATE_FILE;
        const privateKeyFilename = process.env.SB_PRIVATE_KEY_FILE;

        // TODO(bemasc): Remove casts once
        // https://github.com/DefinitelyTyped/DefinitelyTyped/pull/15229 lands
        const apiServer = restify.createServer({
          certificate: fs.readFileSync(certificateFilename),
          key: fs.readFileSync(privateKeyFilename)
        });

        // Pre-routing handlers
        apiServer.pre(restify.CORS());

        // All routes handlers
        const apiPrefix = process.env.SB_API_PREFIX ? `/${process.env.SB_API_PREFIX}` : '';
        apiServer.pre(restify.pre.sanitizePath());
        apiServer.use(restify.jsonp());
        apiServer.use(restify.bodyParser());
        bindService(apiServer, apiPrefix, managerService);

        apiServer.listen(portNumber, () => {
          logging.info(`Manager listening at ${apiServer.url}${apiPrefix}`);
        });
      });
}

function getPersistentFilename(file: string): string {
  const stateDir = process.env.SB_STATE_DIR || DEFAULT_STATE_DIR;
  return path.join(stateDir, file);
}

process.on('unhandledRejection', (error) => {
  logging.error(`unhandledRejection: ${error}`);
});

main().catch((e) => {
  logging.error(e);
  process.exit(1);
});
