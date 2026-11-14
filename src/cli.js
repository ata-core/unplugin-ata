#!/usr/bin/env node
// npx @ata-project/unplugin scan [directory] [--json]
import { scanProject, render } from './scan.js'

const args = process.argv.slice(2)
if (args[0] !== 'scan' || args.includes('--help') || args.includes('-h')) {
  console.log('Usage: unplugin-ata scan [directory] [--json]\n\nReads a project and says which zodResolver and Validator calls the build\nwould compile away, and for the others, why not. Nothing is written.')
  process.exit(args[0] === 'scan' || args.includes('--help') || args.includes('-h') ? 0 : 1)
}
const json = args.includes('--json')
const dir = args.slice(1).find((a) => !a.startsWith('-')) || '.'
const r = await scanProject(dir)
console.log(json ? JSON.stringify(r, null, 2) : render(r))
