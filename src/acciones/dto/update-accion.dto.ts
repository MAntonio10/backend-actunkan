import { PartialType } from '@nestjs/mapped-types';
import { CreateAccionDto } from './create-accion.dto';

export class UpdateAccionDto extends PartialType(CreateAccionDto) {}
