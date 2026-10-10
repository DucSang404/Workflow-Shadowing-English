#!/usr/bin/env node
/**
 * usage: node prune_output.js <outputDir> <keep>
 *
 * Keeps the newest <keep> runs in output/ and deletes every file of the rest.
 *
 * A run is every file whose name starts with its runId (`20261010152936_o87wx7`):
 * the mp4s, the .srt, the record .json, the caption and the cover. Newest is
 * decided by the runId itself, whose prefix is a timestamp, so sorting the
 * strings sorts by time and no mtime is trusted. Anything that does not start
 * with a runId is not ours and is left alone.
 *
 * Runs after the daily build has been published: buffer-publish reads the mp4
 * from output/, and Buffer itself fetches the copy on S3, so nothing needs an
 * older file once that step is done.
 *
 * Cleaning up must never fail the schedule, so a file that will not delete is
 * reported on stderr and the run carries on; only a malformed command line exits
 * non-zero.
 */
const fs = require('fs');
const path = require('path');

const RUN_ID = /^(\d{14}_[a-z0-9]{6})/;

const [dir, keepArg] = process.argv.slice(2);
const keep = Number(keepArg);
if (!dir || !Number.isInteger(keep) || keep < 1) {
  console.error('usage - prune_output.js <outputDir> <keep>, keep a whole number of at least 1');
  process.exit(1);
}

let names = [];
try {
  names = fs.readdirSync(dir);
} catch (err) {
  console.error(`cannot read ${dir} - ${err.message}`);
}

const byRun = new Map();
for (const name of names) {
  const m = RUN_ID.exec(name);
  if (!m) continue;
  if (!byRun.has(m[1])) byRun.set(m[1], []);
  byRun.get(m[1]).push(name);
}

const runs = [...byRun.keys()].sort().reverse();
const removed = runs.slice(keep);
let files = 0;
for (const run of removed) {
  for (const name of byRun.get(run)) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
      files += 1;
    } catch (err) {
      console.error(`${name} - ${err.message}`);
    }
  }
}

process.stdout.write(JSON.stringify({ kept: Math.min(keep, runs.length), removed, files }));
