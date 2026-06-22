#!/usr/bin/env node
// Upload each pre-zipped file matching a glob as its own separate GitHub Actions
// artifact, in one step.
//
// Inputs MUST be zip files. You prepare the zips (one per artifact); this action
// uploads each one's bytes as the artifact blob with content-type application/zip.
// download-artifact (every version) then unzips it, so the files land directly
// inside the downloaded artifact -- no wrapping, no double-zip.
//
// Zero dependencies: it speaks the Artifacts v4 protocol directly on the Node 24
// standard library -- a couple of Twirp/JSON control calls plus one Azure Block
// Blob PUT per file.

"use strict";

const {
    statSync,
    globSync,
    appendFileSync,
    createReadStream,
    openSync,
    readSync,
    closeSync,
} = require("node:fs");
const { basename } = require("node:path");
const { createHash } = require("node:crypto");
const https = require("node:https");
const assert = require("node:assert");

const SERVICE = "github.actions.results.api.v1.ArtifactService";

// --- GitHub Actions plumbing (tiny stand-ins for @actions/core) -------------

const getInput = (n) =>
    (process.env[`INPUT_${n.replace(/ /g, "_").toUpperCase()}`] || "").trim();
const warning = (m) => console.log(`::warning::${m}`);
const notice = (m) => console.log(`::notice::${m}`);
function fail(m) {
    console.log(`::error::${m}`);
    process.exit(1);
}

function setOutput(name, value) {
    const f = process.env.GITHUB_OUTPUT;
    if (!f) return;
    const d = `ghadelim_${Math.random().toString(36).slice(2)}`;
    appendFileSync(f, `${name}<<${d}\n${value}\n${d}\n`);
}

// --- v4 backend / protocol --------------------------------------------------

// Resolve the Artifacts endpoint and the two backend IDs the API needs. The IDs
// aren't plain env vars; they live in the runtime token's `scp` claim as
// `Actions.Results:<runBackendId>:<jobRunBackendId>`. Decode the JWT payload
// (middle base64url segment) to read them out.
function backend() {
    const url = (process.env.ACTIONS_RESULTS_URL || "").replace(/\/+$/, "");
    const token = process.env.ACTIONS_RUNTIME_TOKEN || "";
    if (!url || !token) {
        fail(
            "ACTIONS_RESULTS_URL / ACTIONS_RUNTIME_TOKEN are unset; this action only runs inside a GitHub Actions job",
        );
    }
    const claims = JSON.parse(
        Buffer.from(token.split(".")[1], "base64url").toString(),
    );
    const scope = claims.scp
        .split(" ")
        .find((s) => s.startsWith("Actions.Results:"))
        .split(":");
    return { url, token, run: scope[1], job: scope[2] };
}

// One Twirp/JSON call: POST <base>/twirp/<service>/<Method>, non-200 == failure.
async function twirp(be, method, body) {
    const res = await fetch(`${be.url}/twirp/${SERVICE}/${method}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${be.token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    if (res.status !== 200)
        fail(`${method} returned HTTP ${res.status}: ${await res.text()}`);
    return res.json();
}

async function deleteIfExists(be, name) {
    const list = await twirp(be, "ListArtifacts", {
        workflowRunBackendId: be.run,
        workflowJobRunBackendId: be.job,
        nameFilter: name,
    });
    if (!(list.artifacts || []).length) return;
    await twirp(be, "DeleteArtifact", {
        workflowRunBackendId: be.run,
        workflowJobRunBackendId: be.job,
        name,
    });
}

// Stream a file to the signed Azure blob URL in a single Put Blob, computing its
// sha256 from the same byte stream as it flows. Resolves with the hex digest.
// x-ms-version 2023-11-03 allows up to ~5000 MiB per Put Blob, so no block dance.
function putBlob(url, file, size) {
    return new Promise((resolve, reject) => {
        const hash = createHash("sha256");
        const req = https.request(
            url,
            {
                method: "PUT",
                headers: {
                    "x-ms-blob-type": "BlockBlob",
                    "x-ms-version": "2023-11-03",
                    "Content-Type": "application/zip",
                    "Content-Length": size,
                },
            },
            (res) => {
                let body = "";
                res.on("data", (d) => (body += d));
                res.on("end", () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(hash.digest("hex"));
                    } else {
                        reject(
                            new Error(
                                `blob PUT HTTP ${res.statusCode}: ${body}`,
                            ),
                        );
                    }
                });
            },
        );
        req.on("error", reject);
        const rs = createReadStream(file);
        rs.on("error", reject);
        // Both the hash and the request see every chunk; pipe handles backpressure,
        // so the digest covers exactly the bytes sent and memory stays flat.
        rs.on("data", (c) => hash.update(c));
        rs.pipe(req);
    });
}

async function uploadOne(be, name, file, size, retentionDays) {
    // CreateArtifact reserves the name and returns a signed Azure blob URL.
    const create = {
        workflowRunBackendId: be.run,
        workflowJobRunBackendId: be.job,
        name,
        version: 4,
    };
    if (retentionDays > 0) {
        create.expiresAt = new Date(Date.now() + retentionDays * 86400000)
            .toISOString()
            .replace(/\.\d+Z$/, "Z");
    }
    const created = await twirp(be, "CreateArtifact", create);
    if (!created.ok)
        fail(
            `CreateArtifact rejected '${name}' (does it already exist? try overwrite: true)`,
        );
    if (!created.signed_upload_url) {
        fail(
            `CreateArtifact gave no upload URL for '${name}'; response keys: ${Object.keys(created).join(", ")}`,
        );
    }

    const sha = await putBlob(created.signed_upload_url, file, size);

    const fin = await twirp(be, "FinalizeArtifact", {
        workflowRunBackendId: be.run,
        workflowJobRunBackendId: be.job,
        name,
        size: String(size),
        hash: `sha256:${sha}`,
    });
    if (!fin.ok) fail(`FinalizeArtifact rejected '${name}'`);

    return { name, id: Number(fin.artifact_id), size };
}

// --- input handling ---------------------------------------------------------

// A real zip starts with a local-file (PK\x03\x04) or empty-archive (PK\x05\x06)
// signature. Validating this is the action's trust boundary: we refuse anything
// that isn't a zip rather than upload a blob download-artifact can't unzip.
function isZip(d) {
    return (
        d.length >= 4 &&
        d[0] === 0x50 &&
        d[1] === 0x4b &&
        (d[2] === 0x03 || d[2] === 0x05) &&
        (d[3] === 0x04 || d[3] === 0x06)
    );
}

// Artifact name = basename with a trailing .zip stripped (release.zip -> release),
// so download-artifact extracts it into a `release/` dir with the files inside.
function artifactName(file) {
    return basename(file).replace(/\.zip$/i, "");
}

// Read just the first 4 bytes to check the zip signature, without loading the
// whole (potentially huge) file into memory.
function zipHeader(file) {
    const fd = openSync(file, "r");
    try {
        const buf = Buffer.alloc(4);
        const n = readSync(fd, buf, 0, 4, 0);
        return buf.subarray(0, n);
    } finally {
        closeSync(fd);
    }
}

function splitPatterns(s) {
    return s
        .split(/[\n,]/)
        .map((x) => x.trim())
        .filter(Boolean);
}

async function main() {
    if (process.argv.includes("--selftest")) return selftest();

    const patterns = splitPatterns(getInput("path"));
    if (!patterns.length) fail('input "path" is required');

    const retentionDays = parseInt(getInput("retention-days"), 10) || 0;
    const overwrite = getInput("overwrite") === "true";
    const ifNone = getInput("if-no-files-found") || "warn";

    const files = [...new Set(patterns.flatMap((p) => globSync(p)))].filter(
        (f) => {
            try {
                return statSync(f).isFile();
            } catch {
                return false;
            }
        },
    );

    if (!files.length) {
        const msg = `no files matched: ${patterns.join(", ")}`;
        if (ifNone === "error") fail(msg);
        if (ifNone === "warn") warning(msg);
        setOutput("artifacts", "[]");
        return;
    }

    // Validate every input up front, and reject ambiguous name collisions, before
    // touching the network so a bad input fails fast and uploads nothing.
    const jobs = new Map();
    for (const f of files) {
        if (!isZip(zipHeader(f))) {
            fail(
                `'${f}' is not a zip file. This action uploads pre-zipped artifacts; zip your files first (e.g. 'zip -j out.zip ...').`,
            );
        }
        const name = artifactName(f);
        if (jobs.has(name)) {
            fail(
                `two inputs map to the same artifact name "${name}": ${jobs.get(name).file} and ${f}`,
            );
        }
        jobs.set(name, { file: f, size: statSync(f).size });
    }

    const be = backend();
    const results = [];
    for (const [name, { file, size }] of jobs) {
        if (overwrite) await deleteIfExists(be, name);
        const r = await uploadOne(be, name, file, size, retentionDays);
        notice(`uploaded '${r.name}' (id ${r.id}, ${r.size} bytes)`);
        results.push(r);
    }
    setOutput("artifacts", JSON.stringify(results));
}

// Network-free check of the pure logic: zip detection and name derivation.
function selftest() {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
    const empty = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    assert.ok(isZip(zip), "local-file zip signature accepted");
    assert.ok(isZip(empty), "empty-archive zip signature accepted");
    assert.ok(!isZip(Buffer.from("hello world")), "plain text rejected");
    assert.ok(!isZip(Buffer.from([0x1f, 0x8b])), "gzip rejected (not a zip)");

    assert.equal(artifactName("dist/release.zip"), "release");
    assert.equal(artifactName("dist/app.ZIP"), "app");
    assert.equal(artifactName("dist/already-named"), "already-named");

    console.log("selftest ok");
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
