import { Disposable } from 'vscode';
import type { IntegrationId } from '../../constants.integrations';
import { HostingIntegrationId } from '../../constants.integrations';
import type { Container } from '../../container';

export const supportedStartWorkIntegrations = [HostingIntegrationId.GitHub];

export class StartWorkProvider implements Disposable {
	private readonly _disposable: Disposable;

	constructor(private readonly container: Container) {
		this._disposable = Disposable
			.from
			// configuration.onDidChange(this.onConfigurationChanged, this),
			// container.integrations.onDidChangeConnectionState(this.onIntegrationConnectionStateChanged, this),
			// ...this.registerCommands(),
			();
	}

	dispose() {
		this._disposable.dispose();
	}

	async getConnectedIntegrations(): Promise<Map<IntegrationId, boolean>> {
		const connected = new Map<IntegrationId, boolean>();
		await Promise.allSettled(
			supportedStartWorkIntegrations.map(async integrationId => {
				const integration = await this.container.integrations.get(integrationId);
				connected.set(integrationId, integration.maybeConnected ?? (await integration.isConnected()));
			}),
		);

		return connected;
	}
}
