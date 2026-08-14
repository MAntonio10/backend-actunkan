import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { BitacoraService } from './bitacora.service';
import { QueryBitacoraDto } from './dto/query-bitacora.dto';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

@Controller('bitacora')
export class BitacoraController {
  constructor(private readonly bitacoraService: BitacoraService) {}

  @RequirePermission('Bitacora', 'Ver')
  @Get()
  findAll(@Query() queryDto: QueryBitacoraDto) {
    return this.bitacoraService.findAll(queryDto);
  }

  @RequirePermission('Bitacora', 'Ver')
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.bitacoraService.findOne(id);
  }
}
