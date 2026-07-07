// Track E — GitHub Adapters. THE auth chokepoint (CLAUDE.md Law 3).
import { App, Octokit } from 'octokit';
import type { Env } from '@/config/env';

/**
 * Octokit authenticated AS THE APP INSTALLATION from the webhook payload.
 *
 * WHY app-installation auth (Law 3): check runs can only be created by GitHub
 * Apps; a personal access token yields 403. The installation token also grants
 * access to every repo in the installation — which is how ONE client reads the
 * frontend repo AND writes checks to the backend repo.
 *
 * No caching in v1: installation tokens expire hourly and the App handles
 * renewal internally.
 */
export async function getInstallationClient(
  env: Env,
  installationId: number,
): Promise<Octokit> {
  const app = new App({
    appId: env.githubAppId,
    privateKey: env.githubAppPrivateKey,
  });
  return app.getInstallationOctokit(installationId);
}
