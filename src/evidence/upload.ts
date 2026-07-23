import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { EvidenceAsset, RenderResult } from './render.js'

/**
 * Evidence uploaders: push local render assets to a host and substitute the
 * markdown placeholders with hosted links. One adapter per host; GitLab is
 * first because MR descriptions are the primary consumer.
 */

export interface UploadedAsset {
  asset: EvidenceAsset
  /** markdown reference to the hosted file, e.g. ![alt](/uploads/…/file.png) */
  markdown: string
}

export interface Uploader {
  name: string
  upload(asset: EvidenceAsset): Promise<UploadedAsset>
}

/**
 * GitLab project uploads (`POST /projects/:id/uploads`). The returned
 * `markdown` is project-relative, which is exactly what MR descriptions want.
 */
export class GitLabUploader implements Uploader {
  readonly name = 'gitlab'

  constructor(
    private readonly options: {
      /** e.g. https://gitlab.example.com */
      baseUrl: string
      /** path or numeric id, e.g. group/repo */
      project: string
      token: string
      fetchImpl?: typeof fetch
    }
  ) {}

  async upload(asset: EvidenceAsset): Promise<UploadedAsset> {
    const fetchImpl = this.options.fetchImpl ?? fetch
    const url = `${this.options.baseUrl.replace(/\/$/, '')}/api/v4/projects/${encodeURIComponent(this.options.project)}/uploads`
    const body = new FormData()
    const bytes = await readFile(asset.path)
    body.append('file', new Blob([bytes]), basename(asset.path))
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': this.options.token },
      body,
    })
    if (!response.ok) {
      throw new Error(`gitlab upload failed for ${basename(asset.path)}: HTTP ${response.status}`)
    }
    const json = (await response.json()) as { markdown?: string; url?: string }
    if (!json.markdown && !json.url) {
      throw new Error(`gitlab upload for ${basename(asset.path)} returned no markdown/url`)
    }
    const markdown = json.markdown ?? `![${asset.altText}](${json.url})`
    return { asset, markdown }
  }
}

/** Upload every asset and swap its placeholder inside the rendered markdown. */
export async function uploadEvidence(result: RenderResult, uploader: Uploader): Promise<RenderResult> {
  let markdown = result.markdown
  for (const asset of result.assets) {
    const uploaded = await uploader.upload(asset)
    markdown = markdown.split(asset.placeholder).join(uploaded.markdown)
  }
  return { ...result, markdown, assets: [] }
}

export function gitlabUploaderFromEnv(project: string, env: NodeJS.ProcessEnv = process.env): GitLabUploader {
  const token = env.GITLAB_TOKEN
  if (!token) throw new Error('GITLAB_TOKEN is not set — export it or use --uploader none')
  const baseUrl = env.GITLAB_URL ?? 'https://gitlab.com'
  return new GitLabUploader({ baseUrl, project, token })
}
