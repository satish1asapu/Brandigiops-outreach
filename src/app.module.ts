// src/app.module.ts

import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OutreachModule } from './outreach/outreach.module';

@Module({
  imports: [
    // TODO: replace with your actual MongoDB connection string
    // local:  mongodb://localhost:27017/brandigiops
    // atlas:  mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/brandigiops
    MongooseModule.forRoot(process.env.MONGO_URI || 'mongodb://localhost:27017/brandigiops'),
    OutreachModule,
  ],
})
export class AppModule {}
