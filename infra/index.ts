import * as pulumi from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";

const stack = pulumi.getStack();
const config = new pulumi.Config();
const accountId = config.require("account_id");
const zoneId = config.require("zone_id");
const s2Endpoint = config.require("s2_endpoint");
const s2AccessToken = config.requireSecret("s2_access_token");
const cfApiToken = new pulumi.Config("cloudflare").requireSecret("apiToken");

const domain = config.require("domain");

const API_SESSION_SCRIPT = `txtbox-api-session-${stack}`;
const SNAPSHOTTER_SCRIPT = `txtbox-snapshotter-${stack}`;
const BUCKET_NAME = `txtbox-snapshots-${stack}`;
const R2_DOMAIN = `snapshots.${domain}`;

// R2 bucket + public custom domain
const snapshotsBucket = new cloudflare.R2Bucket("snapshots", {
  accountId,
  name: BUCKET_NAME,
});

const snapshotsDomain = new cloudflare.R2CustomDomain("snapshots-domain", {
  accountId,
  bucketName: snapshotsBucket.name,
  domain: R2_DOMAIN,
  zoneId,
  enabled: true,
});

const r2PublicBase = pulumi.interpolate`https://${snapshotsDomain.domain}`;

// Cron trigger for snapshotter
const snapshotterCron = new cloudflare.WorkersCronTrigger("snapshotter-cron", {
  accountId,
  scriptName: SNAPSHOTTER_SCRIPT,
  schedules: [{ cron: "*/5 * * * *" }],
});

// Worker secrets via Cloudflare REST API (WorkersSecret removed in provider v6)
interface SecretInputs {
  accountId: string;
  apiToken: string;
  scriptName: string;
  secretName: string;
  secretText: string;
}

const workerSecretProvider: pulumi.dynamic.ResourceProvider<SecretInputs> = {
  async create(inputs) {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${inputs.accountId}/workers/scripts/${inputs.scriptName}/secrets`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${inputs.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: inputs.secretName,
          text: inputs.secretText,
          type: "secret_text",
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Failed to set secret ${inputs.secretName} on ${inputs.scriptName}: ${res.status} ${body}`,
      );
    }
    return {
      id: `${inputs.scriptName}/${inputs.secretName}`,
      outs: inputs,
    };
  },

  async update(_id, _olds, news) {
    const result = await this.create!(news);
    return { outs: result.outs };
  },

  async delete() {},
};

class WorkerSecret extends pulumi.dynamic.Resource {
  constructor(
    name: string,
    props: {
      accountId: pulumi.Input<string>;
      apiToken: pulumi.Input<string>;
      scriptName: string;
      secretName: string;
      secretText: pulumi.Input<string>;
    },
    opts?: pulumi.CustomResourceOptions,
  ) {
    super(workerSecretProvider, name, props, opts);
  }
}

function pushSecret(scriptLabel: string, scriptName: string, secretName: string, value: pulumi.Input<string>) {
  new WorkerSecret(`${scriptLabel}-${secretName.toLowerCase().replace(/_/g, "-")}`, {
    accountId,
    apiToken: cfApiToken,
    scriptName,
    secretName,
    secretText: value,
  });
}

// api-session secrets
pushSecret("api", API_SESSION_SCRIPT, "S2_ACCESS_TOKEN", s2AccessToken);
pushSecret("api", API_SESSION_SCRIPT, "S2_ENDPOINT", s2Endpoint);
pushSecret("api", API_SESSION_SCRIPT, "R2_PUBLIC_BASE", r2PublicBase);

// snapshotter secrets
pushSecret("snap", SNAPSHOTTER_SCRIPT, "S2_ACCESS_TOKEN", s2AccessToken);
pushSecret("snap", SNAPSHOTTER_SCRIPT, "S2_ENDPOINT", s2Endpoint);

export const bucketName = snapshotsBucket.name;
export const bucketDomain = snapshotsDomain.domain;
export const cronSchedule = snapshotterCron.schedules;
export const environment = stack;
