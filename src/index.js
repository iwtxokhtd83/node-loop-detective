'use strict';

const { Detective } = require('./detective');
const { Inspector } = require('./inspector');
const { Analyzer } = require('./analyzer');
const { Reporter } = require('./reporter');
const { generateHtmlReport } = require('./html-report');

module.exports = { Detective, Inspector, Analyzer, Reporter, generateHtmlReport };
