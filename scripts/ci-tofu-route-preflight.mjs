#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { request } from 'node:https';

const env = process.env;

function parseLabels(raw, fallback) {
	if (!raw || raw.trim() === '') return fallback;
	const parsed = JSON.parse(raw);
	if (!Array.isArray(parsed) || parsed.some((label) => typeof label !== 'string')) {
		throw new Error('runner labels must be a JSON array of strings');
	}
	return parsed;
}

function setOutput(name, value) {
	if (!env.GITHUB_OUTPUT) return;
	appendFileSync(env.GITHUB_OUTPUT, `${name}=${String(value).replaceAll('\n', ' ')}\n`);
}

function addSummary(markdown) {
	if (!env.GITHUB_STEP_SUMMARY) return;
	appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown.trim()}\n`);
}

function apiGet(path) {
	const token = env.RUNNER_ROUTE_PREFLIGHT_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN;
	if (!token) {
		throw new Error(
			'RUNNER_ROUTE_PREFLIGHT_TOKEN or GITHUB_TOKEN is required to inspect repository runner availability',
		);
	}

	return new Promise((resolve, reject) => {
		const req = request(
			{
				hostname: 'api.github.com',
				path,
				method: 'GET',
				headers: {
					accept: 'application/vnd.github+json',
					authorization: `Bearer ${token}`,
					'user-agent': 'darkmap-ci-tofu-route-preflight',
					'x-github-api-version': '2022-11-28',
				},
			},
			(res) => {
				let body = '';
				res.setEncoding('utf8');
				res.on('data', (chunk) => {
					body += chunk;
				});
				res.on('end', () => {
					if (res.statusCode < 200 || res.statusCode >= 300) {
						const error = new Error(`GitHub API ${res.statusCode}: ${body.slice(0, 500)}`);
						error.statusCode = res.statusCode;
						reject(error);
						return;
					}
					resolve(JSON.parse(body));
				});
			},
		);

		req.on('error', reject);
		req.end();
	});
}

function labelsFor(runner) {
	return new Set((runner.labels || []).map((label) => label.name));
}

function hasAllLabels(runner, requiredLabels) {
	const available = labelsFor(runner);
	return requiredLabels.every((label) => available.has(label));
}

const repository = env.GITHUB_REPOSITORY;
const primaryLabels = parseLabels(env.PRIMARY_LINUX_RUNNER_LABELS_JSON, ['ubuntu-latest']);
const selectedLabels = parseLabels(env.TOFU_LINUX_RUNNER_LABELS_JSON, primaryLabels);
const labelList = selectedLabels.join(', ');
const requiresCluster = env.REQUIRE_CLUSTER_RUNNER !== 'false';
const usesSelfHosted = selectedLabels.includes('self-hosted');
const allowUnverifiedSelfHostedRoute = env.ALLOW_UNVERIFIED_SELF_HOSTED_ROUTE === 'true';

let ready = false;
let reason = '';
let runnerCount = 0;
let matchingRunnerCount = 0;
let runnerApiInspection = 'not-run';

try {
	if (!repository) {
		throw new Error('GITHUB_REPOSITORY is required');
	}

	if (requiresCluster && !usesSelfHosted) {
		reason = 'selected labels do not request a self-hosted cluster-capable runner';
	} else if (!usesSelfHosted) {
		ready = true;
		reason = 'selected labels use GitHub-hosted routing';
	} else {
		try {
			const response = await apiGet(`/repos/${repository}/actions/runners?per_page=100`);
			runnerApiInspection = 'verified';
			const runners = response.runners || [];
			runnerCount = runners.length;
			const matching = runners.filter((runner) => runner.status === 'online' && hasAllLabels(runner, selectedLabels));
			matchingRunnerCount = matching.length;
			ready = matchingRunnerCount > 0;
			if (ready) {
				reason = `found ${matchingRunnerCount} online repository-visible runner(s) matching [${labelList}]`;
			} else if (allowUnverifiedSelfHostedRoute) {
				runnerApiInspection = 'verified-empty-dispatching';
				ready = true;
				reason = `found no online repository-visible runner matching [${labelList}]; dispatching configured ARC route because scale sets may be scale-to-zero`;
			} else {
				reason = `found no online repository-visible runner matching [${labelList}]`;
			}
		} catch (error) {
			if (allowUnverifiedSelfHostedRoute && error?.statusCode === 403) {
				runnerApiInspection = 'forbidden-dispatching';
				ready = true;
				reason = `runner API returned 403 to the workflow token; dispatching configured self-hosted ARC route [${labelList}]`;
			} else {
				throw error;
			}
		}
	}
} catch (error) {
	reason = error instanceof Error ? error.message : String(error);
}

setOutput('ready', ready ? 'true' : 'false');
setOutput('labels_json', JSON.stringify(selectedLabels));
setOutput('label_list', labelList);
setOutput('reason', reason);
setOutput('runner_count', runnerCount);
setOutput('matching_runner_count', matchingRunnerCount);
setOutput('runner_api_inspection', runnerApiInspection);

addSummary(`
### Tofu / deploy route preflight

| Check | Result |
| --- | --- |
| Selected labels | \`${labelList}\` |
| Requires cluster-capable runner | \`${requiresCluster}\` |
| Repository-visible runners | \`${runnerCount}\` |
| Matching online runners | \`${matchingRunnerCount}\` |
| Runner API inspection | \`${runnerApiInspection}\` |
| Ready | \`${ready}\` |
| Reason | ${reason} |

RustFS-backed OpenTofu and Kubernetes deploy jobs must not silently fall back to
hosted runners. If this preflight is not ready, bind a repository-visible
self-hosted runner with the selected labels, provide a runner-read token as
\`RUNNER_ROUTE_PREFLIGHT_TOKEN\`, or change \`TOFU_LINUX_RUNNER_LABELS_JSON\` to
a cluster-capable runner class.
`);

console.log(`ready=${ready}`);
console.log(`labels=${labelList}`);
console.log(`reason=${reason}`);
