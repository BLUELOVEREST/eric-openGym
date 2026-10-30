import { appendFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { ericRelease } from '../../frontend/src/lib/release-version.js'

const pkg = JSON.parse(readFileSync('frontend/package.json', 'utf8'))
const release = ericRelease(process.argv[2], pkg.version)
if (process.env.GITHUB_REPOSITORY !== 'BLUELOVEREST/eric-openGym') throw new Error('Wrong build repository')
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim()
if (git(['rev-parse', 'HEAD']) !== git(['rev-parse', `${release.tag}^{commit}`])) throw new Error('Checkout is not the requested immutable tag')
if (!process.env.GITHUB_ENV) throw new Error('GITHUB_ENV is required')
appendFileSync(process.env.GITHUB_ENV, Object.entries({ RELEASE_TAG: release.tag, APP_BUILD: release.tag, VERSION_NAME: release.versionName, VERSION_CODE: release.versionCode, APK_NAME: release.apkName }).map(([key, value]) => `${key}=${value}\n`).join(''))
console.log(JSON.stringify(release))
