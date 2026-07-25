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
  Request,
} from '@nestjs/common';
import { UsuariosService } from './usuarios.service';
import { CreateUsuarioDto } from './dto/create-usuario.dto';
import { UpdateUsuarioDto } from './dto/update-usuario.dto';
import { AssignPermisosDto } from './dto/assign-permisos.dto';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

@Controller('usuarios')
export class UsuariosController {
  constructor(private readonly usuariosService: UsuariosService) {}

  private getEjecutor(req: any) {
    if (!req.user) return undefined;
    return {
      id: req.user.sub ?? req.user.id,
      email: req.user.email,
    };
  }

  @Post()
  @RequirePermission('Usuarios', 'Crear')
  create(@Body() createUsuarioDto: CreateUsuarioDto, @Request() req: any) {
    return this.usuariosService.create(createUsuarioDto, this.getEjecutor(req));
  }

  @Get()
  @RequirePermission('Usuarios', 'Ver')
  findAll(@Query('incluirAnulados') incluirAnulados?: string) {
    return this.usuariosService.findAll(incluirAnulados === 'true');
  }

  @Get(':id')
  @RequirePermission('Usuarios', 'Ver')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.usuariosService.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('Usuarios', 'Editar')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateUsuarioDto: UpdateUsuarioDto,
    @Request() req: any,
  ) {
    return this.usuariosService.update(id, updateUsuarioDto, this.getEjecutor(req));
  }

  @Patch(':id/activar')
  @RequirePermission('Usuarios', 'Editar')
  activar(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.usuariosService.activar(id, this.getEjecutor(req));
  }

  @Delete(':id')
  @RequirePermission('Usuarios', 'Anular')
  remove(
    @Param('id', ParseIntPipe) id: number,
    @Request() req: any,
  ) {
    return this.usuariosService.remove(id, this.getEjecutor(req));
  }

  @Post(':id/permisos')
  @RequirePermission('Usuarios', 'Editar')
  assignPermisos(
    @Param('id', ParseIntPipe) id: number,
    @Body() assignPermisosDto: AssignPermisosDto,
    @Request() req: any,
  ) {
    return this.usuariosService.assignPermisos(id, assignPermisosDto, this.getEjecutor(req));
  }
}
