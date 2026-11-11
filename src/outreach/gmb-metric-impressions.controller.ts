import { Controller, Get, Query } from '@nestjs/common';
import { GmbImpressionsService } from './gmb-impressions.service';

/** Drop-in for main marketops API: GET /gmbImpressions/get → gmbmetricsimpressions */
@Controller('gmbImpressions')
export class GmbMetricImpressionsController {
  constructor(private readonly gmbImpressionsService: GmbImpressionsService) {}

  @Get('get')
  getImpression(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('clientId') clientId?: string,
    @Query('gmbId') gmbId?: string,
  ) {
    return this.gmbImpressionsService.getImpressionMainApi(
      clientId ?? '',
      gmbId ?? '',
      startDate,
      endDate,
    );
  }
}
