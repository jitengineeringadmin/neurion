import { Module } from '@nestjs/common';
import { ProjectsController, ProjectsService } from './projects.controller';

@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService],
})
export class ProjectsModule {}
