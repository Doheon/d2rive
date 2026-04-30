#!/usr/bin/env node
const { execFileSync } = require('child_process')
const path = require('path')

const electron = require(path.join(__dirname, '../node_modules/electron'))
const appDir = path.join(__dirname, '..')

execFileSync(electron, [appDir], { stdio: 'inherit' })
