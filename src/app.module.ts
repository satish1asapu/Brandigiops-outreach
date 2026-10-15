import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { OutreachModule } from './outreach/outreach.module';
import { SecretManagerModule } from './secretemanager';
import { SecretManagerService } from './services/secretmanagerService';
import { MongoConnectionGuardService } from './utils/mongoConnectionGuard.service';
import { MONGO_OPTIONS, buildMongoUri } from './utils/mongoConfig';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    SecretManagerModule,
    MongooseModule.forRootAsync({
      imports: [ConfigModule, SecretManagerModule],
      inject: [ConfigService, SecretManagerService],
      useFactory: async (
        configService: ConfigService,
        secretManagerService: SecretManagerService,
      ) => {
        const uri = await buildMongoUri(configService, secretManagerService);
        console.log('Mongo URI:', uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@'));
        return {
          uri,
          ...MONGO_OPTIONS,
          retryAttempts: 30,
          retryDelay: 3000,
        };
      },
    }),
    OutreachModule,
  ],
  providers: [MongoConnectionGuardService],
})
export class AppModule {}
