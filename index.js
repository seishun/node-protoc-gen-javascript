#!/usr/bin/env node
const { Generator } = require('./generator');

require('protoc-plugin')(new Generator());
