import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { OutreachModule } from './outreach/outreach.module';
import { SecretManagerModule } from './secretemanager';
import { SecretManagerService } from './services/secretmanagerService';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule, SecretManagerModule],
      inject: [ConfigService, SecretManagerService],
      useFactory: async (
        configService: ConfigService,
        secretManagerService: SecretManagerService,
      ) => {
        const environment = configService.get<string>('ENVIRONMENT')?.toUpperCase();
        const secret = await secretManagerService.getSecrectKey();
        const env = environment
          ? environment.charAt(0).toUpperCase() + environment.slice(1).toLowerCase()
          : undefined;

        let mongoUrl: string;
        if (configService.get<string>('SSH_TUNNEL') === 'true') {
          const tunnel = await secretManagerService.sshTunnel();
          mongoUrl = `mongodb://${tunnel.localHost}:${tunnel.localPort}/${configService.get<string>('DB_NAME')}`;
          console.log('SSH tunnel MongoDB URI:', mongoUrl);
        } else {
          mongoUrl = `mongodb://${secret[`mongoDBDomain${env}`]}/${configService.get<string>('DB_NAME')}`;
          console.log('Direct MongoDB URI:', mongoUrl);
        }

        return {
          uri: mongoUrl,
          maxPoolSize: 20,
          serverSelectionTimeoutMS: 5000,
          socketTimeoutMS: 45000,
        };
      },
    }),
    OutreachModule,
  ],
})
export class AppModule {}
