import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AWS = require('aws-sdk');
import { createTunnel } from 'tunnel-ssh';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const getPort = require('get-port');

@Injectable()
export class SecretManagerService {
  private readonly secretsManager: any;

  constructor(private readonly configService: ConfigService) {
    const accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID_CS');
    const secretAccessKey = this.configService.get<string>('AWS_SECRET_ACCESS_KEY_CS');

    if (!accessKeyId || !secretAccessKey) {
      throw new Error('AWS credentials are missing in the environment variables.');
    }

    this.secretsManager = new AWS.SecretsManager({
      region: this.configService.get<string>('AWS_REGION'),
      credentials: {
        accessKeyId: accessKeyId,
        secretAccessKey: secretAccessKey,
      },
    });
  }

  async getSecrectKey() {
    try {
      const secretValue = await this.secretsManager
        .getSecretValue({ SecretId: 'JWKSUri' })
        .promise();
      if (secretValue.SecretString) {
        return JSON.parse(secretValue.SecretString);
      }
    } catch (error) {
      console.error('Failed to retrieve secret values:', error);
      throw new Error('Failed to retrieve secret values');
    }
  }

  async sshTunnel() {
    try {
      const secret = await this.getSecrectKey();
      const environment =
        this.configService.get<string>('ENVIRONMENT')?.toUpperCase() || 'DEVELOPMENT';
      const env = environment.charAt(0).toUpperCase() + environment.slice(1).toLowerCase();
      const localPort = await getPort();

      const tunnelConfig = {
        username: secret.bastionUserName,
        host: secret.bastionHost,
        port: 22,
        privateKey: secret.mongoPem.replace(/\\n/g, '\n'),
        dstHost: secret[`mongoDBDomain${env}`],
        dstPort: 27017,
        localHost: '127.0.0.1',
        localPort: localPort,
      };

      if (!tunnelConfig.dstHost) {
        throw new Error(`MongoDB domain not found for environment: ${env}`);
      }

      await createTunnel(
        { autoClose: true, reconnectOnError: true },
        { host: tunnelConfig.localHost, port: tunnelConfig.localPort },
        {
          host: tunnelConfig.host,
          port: tunnelConfig.port,
          username: tunnelConfig.username,
          privateKey: tunnelConfig.privateKey,
        },
        {
          srcAddr: tunnelConfig.localHost,
          srcPort: tunnelConfig.localPort,
          dstAddr: tunnelConfig.dstHost,
          dstPort: tunnelConfig.dstPort,
        },
      );

      console.log(
        `SSH tunnel established on ${tunnelConfig.localHost}:${tunnelConfig.localPort}`,
      );
      return tunnelConfig;
    } catch (error) {
      console.error('SSH tunnel creation failed:', error);
      throw error;
    }
  }
}
