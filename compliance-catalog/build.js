#!/usr/bin/env node

/**
 * Build script for the compliance catalog.
 *
 * Reads YAML data files from a data directory, validates the schema
 * and referential integrity, bundles everything with the HTML template,
 * styles, and frontend script, and writes a single self-contained HTML
 * file to the output path.
 *
 * Usage:
 *   node build.js
 *   node build.js --data data-example --output dist/example.html
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Parse command line arguments
const args = process.argv.slice(2);
function getArg(name, defaultValue) {
  const idx = args.indexOf(name);
  if (idx === -1) return defaultValue;
  return args[idx + 1];
}

const dataDir = getArg('--data', 'data');
const outputPath = getArg('--output', 'dist/compliance-catalog.html');
const templatePath = getArg('--template', 'src/template.html');
const stylesPath = getArg('--styles', 'src/styles.css');
const appPath = getArg('--app', 'src/app.js');

// Load a YAML file and return its content
function loadYaml(filename) {
  const fullPath = path.join(dataDir, filename);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Data file not found: ${fullPath}`);
  }
  const raw = fs.readFileSync(fullPath, 'utf8');
  return yaml.load(raw);
}

// Validate that required top-level arrays exist in each file
function validateSchema(rawData) {
  const requiredKeys = {
    regulations: 'regulations',
    obligations: 'obligations',
    documents: 'documents',
    mappings: 'mappings',
    roles: 'roles'
  };
  for (const [file, key] of Object.entries(requiredKeys)) {
    if (!rawData[file] || !Array.isArray(rawData[file][key])) {
      throw new Error(`${file}.yaml is missing required top-level array: ${key}`);
    }
  }
}

// Validate referential integrity across files
function validateReferences(data) {
  const regIds = new Set(data.regulations.map(r => r.id));
  const oblIds = new Set(data.obligations.map(o => o.id));
  const docIds = new Set(data.documents.map(d => d.id));
  const roleIds = new Set(data.roles.map(r => r.id));
  const validStatuses = new Set(['verified', 'deviations_noted', 'verification_pending']);

  const errors = [];

  data.obligations.forEach(o => {
    if (!regIds.has(o.regulation_id)) {
      errors.push(`Obligation ${o.id} references unknown regulation: ${o.regulation_id}`);
    }
    if (o.accountable_role && !roleIds.has(o.accountable_role)) {
      errors.push(`Obligation ${o.id} references unknown role: ${o.accountable_role}`);
    }
  });

  data.mappings.forEach(m => {
    if (!oblIds.has(m.obligation_id)) {
      errors.push(`Mapping references unknown obligation: ${m.obligation_id}`);
    }
    if (m.status && !validStatuses.has(m.status)) {
      errors.push(`Mapping for ${m.obligation_id} has invalid status: ${m.status}. Must be one of: ${[...validStatuses].join(', ')}`);
    }
    (m.documents || []).forEach(d => {
      if (!docIds.has(d.document_id)) {
        errors.push(`Mapping for ${m.obligation_id} references unknown document: ${d.document_id}`);
      }
    });
  });

  if (errors.length > 0) {
    throw new Error('Referential integrity errors:\n  ' + errors.join('\n  '));
  }
}

// Main build
function build() {
  console.log(`Building compliance catalog from ${dataDir}`);

  const rawData = {
    regulations: loadYaml('regulations.yaml'),
    obligations: loadYaml('obligations.yaml'),
    documents: loadYaml('documents.yaml'),
    mappings: loadYaml('mappings.yaml'),
    roles: loadYaml('roles.yaml')
  };

  validateSchema(rawData);

  const data = {
    regulations: rawData.regulations.regulations,
    obligations: rawData.obligations.obligations,
    documents: rawData.documents.documents,
    mappings: rawData.mappings.mappings,
    roles: rawData.roles.roles,
    build_metadata: {
      built_at: new Date().toISOString(),
      data_source: dataDir,
      tool_version: require('./package.json').version
    }
  };

  validateReferences(data);

  const template = fs.readFileSync(templatePath, 'utf8');
  const styles = fs.readFileSync(stylesPath, 'utf8');
  const app = fs.readFileSync(appPath, 'utf8');

  const dataStatement =
  'window.COMPLIANCE_DATA = ' + JSON.stringify(data, null, 2) + ';';

  const output = template
    .replace('/* __STYLES_PLACEHOLDER__ */', styles)
    .replace('/* __DATA_PLACEHOLDER__ */', dataStatement)
    .replace('/* __APP_PLACEHOLDER__ */', app);

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(outputPath, output);

  console.log(`Built: ${outputPath}`);
  console.log(`  ${data.regulations.length} regulations`);
  console.log(`  ${data.obligations.length} obligations`);
  console.log(`  ${data.documents.length} documents`);
  console.log(`  ${data.mappings.length} mappings`);
  console.log(`  ${data.roles.length} roles`);
}

try {
  build();
} catch (err) {
  console.error('Build failed:', err.message);
  process.exit(1);
}
