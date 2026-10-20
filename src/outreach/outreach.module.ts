// outreach.module.ts



import { Module } from '@nestjs/common';

import { MongooseModule } from '@nestjs/mongoose';



import { Target, TargetSchema } from './schemas/target.schema';

import { OutreachLink, OutreachLinkSchema } from './schemas/outreach-link.schema';

import {

  ClientOnboarding,

  ClientOnboardingSchema,

} from './schemas/client-onboarding.schema';

import { ClientCustomer, ClientCustomerSchema } from './schemas/client-customer.schema';

import { GmbReviews, GmbReviewsSchema } from './schemas/gmb-reviews.schema';

import {

  GmbMetricImpressions,

  GmbMetricImpressionsSchema,

} from './schemas/gmb-metric-impressions.schema';

import { GmbPosts, GmbPostsSchema } from './schemas/gmb-posts.schema';

import { GmbReviewsService } from './gmb-reviews.service';

import { GmbImpressionsService } from './gmb-impressions.service';

import { SerpApiReviewsService } from './serpapi-reviews.service';

import { PostProxyEnvService } from './postproxy-env.service';

import { PostProxyMetricsService } from './postproxy-metrics.service';

import { GmbSerpBundleService } from './gmb-serp-bundle.service';

import { PostProxyCommentsService } from './postproxy-comments.service';

import { PostProxyPostsService } from './postproxy-posts.service';

import { GmbPostsService } from './gmb-posts.service';

import { OutreachService } from './outreach.service';

import { OutreachController } from './outreach.controller';

import { WhatsAppService } from './whatsapp.service';

import { ReviewFollowUpService } from './review-followup.service';

import { PostProxyCustomerReviewMonitorService } from './postproxy-customer-review-monitor.service';

import { SerpApiReviewDetector, REVIEW_DETECTOR } from './review-detector';



@Module({

  imports: [

    MongooseModule.forFeature([

      { name: Target.name, schema: TargetSchema },

      { name: OutreachLink.name, schema: OutreachLinkSchema },

      { name: ClientOnboarding.name, schema: ClientOnboardingSchema },

      { name: ClientCustomer.name, schema: ClientCustomerSchema },

      { name: GmbReviews.name, schema: GmbReviewsSchema },

      { name: GmbMetricImpressions.name, schema: GmbMetricImpressionsSchema },

      { name: GmbPosts.name, schema: GmbPostsSchema },

    ]),

  ],

  controllers: [OutreachController],

  providers: [

    OutreachService,

    WhatsAppService,

    ReviewFollowUpService,

    PostProxyCustomerReviewMonitorService,

    GmbReviewsService,

    GmbImpressionsService,

    SerpApiReviewsService,

    PostProxyEnvService,

    PostProxyMetricsService,

    GmbSerpBundleService,

    PostProxyCommentsService,

    PostProxyPostsService,

    GmbPostsService,

    { provide: REVIEW_DETECTOR, useClass: SerpApiReviewDetector },

  ],

  exports: [OutreachService],

})

export class OutreachModule {}


