import { AgentUnavailableError, type AgentClient } from './client.js';

/** Used when AGENT_TOKEN is not configured: every call explains what is missing. */
export function unavailableAgent(): AgentClient {
  const fail = async (): Promise<never> => {
    throw new AgentUnavailableError('AGENT_TOKEN is not configured; the panel cannot manage game servers.');
  };
  return {
    hostPorts: fail,
    list: fail,
    state: fail,
    install: fail,
    start: fail,
    stop: fail,
    kill: fail,
    remove: fail,
    logs: fail,
    query: fail,
    readFile: fail,
    writeFile: fail,
    statFile: fail,
    snapshotPackages: fail,
    packageHistory: fail,
    restorePackages: fail,
    storeBackup: fail,
    readBackup: fail,
    deleteBackup: fail,
    listBackups: fail,
    installedBuild: fail,
    latestBuild: fail,
    stats: fail,
    followLogs: fail,
  };
}
