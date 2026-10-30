import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import test from 'node:test'
const { load } = createRequire(import.meta.url)('js-yaml')
const workflow = load(readFileSync(new URL('../../.github/workflows/eric-apk.yml', import.meta.url), 'utf8'))
const job = workflow.jobs.apk
test('only the approved fork builds custom tags with bounded publication permissions', () => {
  assert.equal(job.if, "github.repository == 'BLUELOVEREST/eric-openGym'")
  assert.deepEqual(workflow.on.push.tags, ['v*-eric.*'])
  assert.equal(workflow.permissions.contents, 'write')
  assert.equal(workflow.concurrency['cancel-in-progress'], false)
  assert.equal(job.env.GH_TOKEN, undefined)
  assert.equal(job.steps.find(step => step.name === 'Publish verified APK').env.GH_TOKEN, '${{ github.token }}')
})
test('all shell blocks parse and fail on errors', () => {
  for (const step of job.steps.filter(step => step.run)) {
    assert.equal(spawnSync('bash', ['-n'], { input: step.run }).status, 0, step.name)
    assert.match(step.run, /^set -euo pipefail\n/)
    assert.equal(step['continue-on-error'], undefined)
  }
})
test('licensed mobile assets, signed ARM64 release and verified metadata gate publication', () => {
  const commands = job.steps.map(step => step.run || '').join('\n')
  for (const required of ['check-media.mjs', 'stage-media.mjs', 'check-mobile-bundle.mjs', 'assembleSideloadRelease', '-PericReleaseTag=', 'apksigner', 'zipalign', 'ANDROID_CERT_SHA256', 'verify-eric-apk.mjs', 'sha256sum', 'gh release create', '--draft', 'gh release edit']) assert.ok(commands.includes(required), required)
  assert.ok(!commands.includes('APP_MEDIA_DIR='))
  assert.ok(!commands.includes('assembleDebug'))
  assert.ok(commands.indexOf('verify-eric-apk.mjs') < commands.indexOf('gh release create'))
  assert.ok(!commands.includes('--clobber'))
  assert.ok(commands.includes('env:ANDROID_STORE_PASSWORD'))
})
test('fork releases cannot publish official images or fail official-main ancestry checks', () => {
  for (const [file, name] of [['docker-publish.yml', 'build'], ['release-check.yml', 'versions']]) {
    const original = load(readFileSync(new URL('../../.github/workflows/' + file, import.meta.url), 'utf8'))
    assert.equal(original.jobs[name].if, "github.repository == 'DuarteSantos8/openGym'")
  }
})
