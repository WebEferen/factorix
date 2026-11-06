import { environmentInput, writeEnvironmentFile } from '@factorix/schemas'
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../deps'
import { requireAdmin, requireAuth } from '../lib/auth'
import { badRequest, conflict, parseBody } from '../lib/errors'
import { environmentDto, saveEnvironment, secretSourceFor, testEnvironment } from '../services/environments'
import { getProject } from './projects'

export function environmentRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps

  app.get('/api/projects/:id/environment', async (request) => {
    const { account } = requireAuth(request)
    const project = await getProject(deps, account.orgId, (request.params as { id: string }).id)
    return { environment: await environmentDto(db, project.id) }
  })

  app.get('/api/projects/:id/environment/export', async (request, reply) => {
    const { account } = requireAuth(request)
    const project = await getProject(deps, account.orgId, (request.params as { id: string }).id)
    const environment = await environmentDto(db, project.id)
    if (environment.version === 0) throw conflict('This project has no saved environment to export.')
    const file =
      project.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'project'
    return reply
      .header('content-type', 'application/yaml; charset=utf-8')
      .header('content-disposition', `attachment; filename="${file}-environment.yaml"`)
      .send(writeEnvironmentFile({ project: project.name, source: environment.source, secretSets: environment.secretSets }))
  })

  app.put('/api/projects/:id/environment', async (request) => {
    const { account } = requireAdmin(request)
    const project = await getProject(deps, account.orgId, (request.params as { id: string }).id)
    const input = parseBody(environmentInput, request.body)
    return { environment: await saveEnvironment(deps, account, project, input) }
  })

  app.post('/api/projects/:id/environment/test', async (request) => {
    const { account } = requireAdmin(request)
    const project = await getProject(deps, account.orgId, (request.params as { id: string }).id)
    return testEnvironment(deps, account.orgId, project, parseBody(environmentInput, request.body))
  })

  app.get('/api/secret-sources/:id/projects', async (request) => {
    const { account } = requireAdmin(request)
    const source = await secretSourceFor(deps, account.orgId, (request.params as { id: string }).id)
    const projects = await source.listProjects()
    return { projects: projects?.map((project) => ({ id: project.id, name: project.name, detail: null })) ?? null }
  })

  app.get('/api/secret-sources/:id/configs', async (request) => {
    const { account } = requireAdmin(request)
    const { project } = request.query as { project?: string }
    if (!project) throw badRequest('project is required')
    const source = await secretSourceFor(deps, account.orgId, (request.params as { id: string }).id)
    const configs = await source.listConfigs(project)
    return { configs: configs?.map((config) => ({ id: config.name, name: config.name, detail: config.environment })) ?? null }
  })
}
