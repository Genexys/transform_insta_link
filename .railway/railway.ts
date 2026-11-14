import { defineRailway, github, project, service } from "railway/iac";
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "transform_insta_link";
export default defineRailway(() => {
  const transform_insta_link = service("transform_insta_link", {
    source: github("Genexys/transform_insta_link", { branch: "master", checkSuites: false }),
    // No builder value: Railway builds from the root `Dockerfile` automatically
    // ("Using detected Dockerfile!" in the build log). Omitting it clears the
    // old explicit NIXPACKS builder on apply.
    build: { buildEnvironment: "V3" },
    start: "npm run railway:start",
    // Liveness only: /health reports third-party fixer state and can return
    // 503, which must not fail a deploy of a healthy bot.
    healthcheck: "/healthz",
    healthcheckTimeout: 10,
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10 },
    replicas: { "europe-west4-drams3a": 1 },
    networking: { privateNetworkEndpoint: "transforminstalink" },
  });

  return project("observant-caring", {
    variables: { managed: false },
    resources: [transform_insta_link],
  });
});
