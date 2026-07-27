// outreach.module.ts

import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Target, TargetSchema } from './schemas/target.schema';
import { OutreachLink, OutreachLinkSchema } from './schemas/outreach-link.schema';
import { OutreachService } from './outreach.service';
import { OutreachController } from './outreach.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Target.name, schema: TargetSchema },
      { name: OutreachLink.name, schema: OutreachLinkSchema },
    ]),
  ],
  controllers: [OutreachController],
  providers: [OutreachService],
  exports: [OutreachService],
})
export class OutreachModule {}
