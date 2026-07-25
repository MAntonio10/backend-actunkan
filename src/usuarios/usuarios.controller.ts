import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { UsuariosService } from './usuarios.service';
import { CreateUsuarioDto } from './dto/create-usuario.dto';
import { UpdateUsuarioDto } from './dto/update-usuario.dto';
import { AssignPermisosDto } from './dto/assign-permisos.dto';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

@Controller('usuarios')
export class UsuariosController {
  constructor(private readonly usuariosService: UsuariosService) {}

  @Post()
  @RequirePermission('usuarios', 'crear')
  create(@Body() createUsuarioDto: CreateUsuarioDto) {
    return this.usuariosService.create(createUsuarioDto);
  }

  @Get()
  @RequirePermission('usuarios', 'ver')
  findAll(@Query('incluirAnulados') incluirAnulados?: string) {
    return this.usuariosService.findAll(incluirAnulados === 'true');
  }

  @Get(':id')
  @RequirePermission('usuarios', 'ver')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.usuariosService.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('usuarios', 'editar')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateUsuarioDto: UpdateUsuarioDto,
  ) {
    return this.usuariosService.update(id, updateUsuarioDto);
  }

  @Delete(':id')
  @RequirePermission('usuarios', 'anular')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.usuariosService.remove(id);
  }

  @Post(':id/permisos')
  @RequirePermission('usuarios', 'editar')
  assignPermisos(
    @Param('id', ParseIntPipe) id: number,
    @Body() assignPermisosDto: AssignPermisosDto,
  ) {
    return this.usuariosService.assignPermisos(id, assignPermisosDto);
  }
}
