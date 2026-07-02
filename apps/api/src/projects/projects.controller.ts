import { Body, Controller, Delete, ForbiddenException, Get, Injectable, Param, Post, Put } from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve as pathResolve, sep } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

const pexec = promisify(exec);

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Opens a native folder-picker on the host (this machine) and returns the chosen path. */
  async pickFolder(initial?: string): Promise<{ path: string | null }> {
    if (process.platform !== 'win32') return { path: null };
    const home = process.env.USERPROFILE ?? '';
    const seed =
      initial && existsSync(initial) ? initial : home ? join(home, 'Desktop') : '';
    const seedLine = seed ? `$f.SelectedPath = '${seed.replace(/'/g, "''")}'; ` : '';
    const ps =
      "Add-Type -AssemblyName System.Windows.Forms; " +
      "$f = New-Object System.Windows.Forms.FolderBrowserDialog; " +
      "$f.Description = 'Seleziona la cartella del progetto Neurion'; " +
      "$f.ShowNewFolderButton = $true; " +
      seedLine +
      "$d = $f.ShowDialog([System.Windows.Forms.NativeWindow]::new()); " +
      "if ($d -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.SelectedPath) }";
    try {
      const { stdout } = await pexec(
        `powershell -STA -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"')}"`,
        { timeout: 120000, windowsHide: false },
      );
      const p = stdout.trim();
      return { path: p ? p.replace(/\\/g, '/') : null };
    } catch {
      return { path: null };
    }
  }

  create(user: AuthUser, name: string, path: string) {
    return this.prisma.project.create({ data: { workspaceId: user.workspaceId, userId: user.sub, name, path } });
  }
  list(user: AuthUser) {
    return this.prisma.project.findMany({ where: { userId: user.sub }, orderBy: { createdAt: 'desc' } });
  }
  async remove(user: AuthUser, id: string) {
    const p = await this.prisma.project.findUnique({ where: { id } });
    if (!p || p.userId !== user.sub) throw new ForbiddenException('not your project');
    await this.prisma.chatConversation.updateMany({ where: { projectId: id }, data: { projectId: null } });
    await this.prisma.project.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Read an HTML file from a project folder for the in-app preview. Confined to the
   * caller's OWN project folders (the dir must be one, or under one) so this can't read
   * arbitrary files off disk, and the file path can't escape the dir.
   */
  async previewHtml(user: AuthUser, dir: string, file?: string): Promise<{ files: string[]; file: string | null; content: string | null }> {
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
    const d = norm(dir || '');
    const projects = await this.list(user);
    const ok = projects.some((p) => { const pp = norm(p.path); return !!pp && (d === pp || d.startsWith(pp + '/')); });
    if (!ok) throw new ForbiddenException('not one of your project folders');

    // list top-level + one-level-deep .html files
    const htmls: string[] = [];
    const scan = (rel: string, depth: number) => {
      const abs = join(dir, rel);
      let entries: string[] = [];
      try { entries = readdirSync(abs); } catch { return; }
      for (const e of entries) {
        const r = rel ? `${rel}/${e}` : e;
        let st; try { st = statSync(join(dir, r)); } catch { continue; }
        if (st.isDirectory()) { if (depth < 1 && !/node_modules|\.git/.test(e)) scan(r, depth + 1); }
        else if (/\.html?$/i.test(e)) htmls.push(r);
      }
    };
    scan('', 0);
    htmls.sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));

    const want = (file && file.replace(/\\/g, '/')) || htmls[0] || null;
    if (!want || want.includes('..')) return { files: htmls, file: null, content: null };
    const full = pathResolve(join(dir, want));
    if (full !== pathResolve(dir) && !full.startsWith(pathResolve(dir) + sep)) throw new ForbiddenException('path escapes the folder');
    let content: string | null = null;
    try { if (existsSync(full)) content = readFileSync(full, 'utf8').slice(0, 3_000_000); } catch { content = null; }
    return { files: htmls, file: want, content };
  }

  private assertOwnFolder(projects: { path: string }[], dir: string): void {
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
    const d = norm(dir || '');
    if (!projects.some((p) => { const pp = norm(p.path); return !!pp && (d === pp || d.startsWith(pp + '/')); })) {
      throw new ForbiddenException('not one of your project folders');
    }
  }

  /** Read the per-project rules file (NEURION.md etc.) the agent auto-follows. */
  async getRules(user: AuthUser, dir: string): Promise<{ file: string; exists: boolean; content: string }> {
    this.assertOwnFolder(await this.list(user), dir);
    for (const name of ['NEURION.md', 'AGENTS.md', 'CLAUDE.md', '.neurion.md']) {
      const p = join(dir, name);
      if (existsSync(p)) { try { return { file: name, exists: true, content: readFileSync(p, 'utf8').slice(0, 12_000) }; } catch { /* next */ } }
    }
    return { file: 'NEURION.md', exists: false, content: '' };
  }

  /** Write NEURION.md in the project folder. */
  async setRules(user: AuthUser, dir: string, content: string): Promise<{ file: string; exists: boolean; content: string }> {
    this.assertOwnFolder(await this.list(user), dir);
    const full = join(dir, 'NEURION.md');
    const clean = String(content ?? '').slice(0, 12_000);
    writeFileSync(full, clean);
    return { file: 'NEURION.md', exists: true, content: clean };
  }
}

class CreateProjectDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsString()
  @MaxLength(500)
  path!: string;
}

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProjectDto) {
    return this.projects.create(user, dto.name, dto.path);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.projects.list(user);
  }

  @Post('pick-folder')
  pickFolder(@Body() dto: { initial?: string }) {
    return this.projects.pickFolder(dto?.initial);
  }

  @Post('preview')
  preview(@CurrentUser() user: AuthUser, @Body() dto: { dir: string; file?: string }) {
    return this.projects.previewHtml(user, dto?.dir ?? '', dto?.file);
  }

  @Post('rules')
  getRules(@CurrentUser() user: AuthUser, @Body() dto: { dir: string }) {
    return this.projects.getRules(user, dto?.dir ?? '');
  }

  @Put('rules')
  setRules(@CurrentUser() user: AuthUser, @Body() dto: { dir: string; content: string }) {
    return this.projects.setRules(user, dto?.dir ?? '', dto?.content ?? '');
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.projects.remove(user, id);
  }
}
