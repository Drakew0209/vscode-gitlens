import type { QuickInputButton, QuickPick } from 'vscode';
import { ThemeIcon, Uri } from 'vscode';
import type {
	AsyncStepResultGenerator,
	PartialStepState,
	StepGenerator,
	StepResultGenerator,
	StepSelection,
	StepState,
} from '../../commands/quickCommand';
import {
	canPickStepContinue,
	createPickStep,
	endSteps,
	freezeStep,
	QuickCommand,
	StepResultBreak,
} from '../../commands/quickCommand';
import { ensureAccessStep } from '../../commands/quickCommand.steps';
import { getSteps } from '../../commands/quickWizard.utils';
import type { OpenWalkthroughCommandArgs } from '../../commands/walkthroughs';
import { proBadge } from '../../constants';
import { Commands } from '../../constants.commands';
import type { IntegrationId } from '../../constants.integrations';
import { HostingIntegrationId } from '../../constants.integrations';
import type { Container } from '../../container';
import { PlusFeatures } from '../../features';
import type { SearchedIssue } from '../../git/models/issue';
import type { QuickPickItemOfT } from '../../quickpicks/items/common';
import { createQuickPickItemOfT, createQuickPickSeparator } from '../../quickpicks/items/common';
import type { DirectiveQuickPickItem } from '../../quickpicks/items/directive';
import { createDirectiveQuickPickItem, Directive, isDirectiveQuickPickItem } from '../../quickpicks/items/directive';
import { fromNow } from '../../system/date';
import { some } from '../../system/iterable';
import { executeCommand } from '../../system/vscode/command';
import { supportedStartWorkIntegrations } from './startWorkProvider';

export type StartWorkItem = {
	item: SearchedIssue;
};

export const StartWorkQuickInputButton: QuickInputButton = {
	iconPath: new ThemeIcon('beaker'),
	tooltip: 'Start Work on this Item',
};

export type StartWorkResult = { items: StartWorkItem[] };

interface Context {
	result: StartWorkResult;
	title: string;
	connectedIntegrations: Map<IntegrationId, boolean>;
}

interface State {
	item?: StartWorkItem;
	action?: StartWorkAction;
}

type StartWorkStepState<T extends State = State> = RequireSome<StepState<T>, 'item'>;

export type StartWorkAction = 'start';

export interface StartWorkCommandArgs {
	readonly command: 'startWork';
}

function assertsStartWorkStepState(state: StepState<State>): asserts state is StartWorkStepState {
	if (state.item != null) return;

	debugger;
	throw new Error('Missing item');
}

export class StartWorkCommand extends QuickCommand<State> {
	constructor(container: Container) {
		super(container, 'startWork', 'startWork', `Start Work\u00a0\u00a0${proBadge}`, {
			description: 'Start work on an issue',
		});

		this.initialState = {
			counter: 0,
		};
	}

	protected async *steps(state: PartialStepState<State>): StepGenerator {
		if (this.container.git.isDiscoveringRepositories) {
			await this.container.git.isDiscoveringRepositories;
		}

		const context: Context = {
			result: { items: [] },
			title: this.title,
			connectedIntegrations: await this.container.startWork.getConnectedIntegrations(),
		};

		while (this.canStepsContinue(state)) {
			context.title = this.title;

			const hasConnectedIntegrations = [...context.connectedIntegrations.values()].some(c => c);
			if (!hasConnectedIntegrations) {
				const result = yield* this.confirmCloudIntegrationsConnectStep(state, context);
				if (result === StepResultBreak) {
					return result;
				}
			}
			const result = yield* ensureAccessStep(state, context, PlusFeatures.Launchpad);
			if (result === StepResultBreak) continue;

			await updateContextItems(this.container, context);

			if (state.counter < 1 || state.item == null) {
				const result = yield* this.pickIssueStep(state, context);
				if (result === StepResultBreak) continue;
				state.item = result;
			}

			assertsStartWorkStepState(state);

			if (state.action == null && this.confirm(state.confirm)) {
				const result = yield* this.confirmStep(state, context);
				if (result === StepResultBreak) {
					state.item = undefined!;
					continue;
				}

				state.action = result;
			}

			if (typeof state.action === 'string') {
				switch (state.action) {
					case 'start':
						yield* getSteps(
							this.container,
							{
								command: 'branch',
								state: {
									subcommand: 'create',
									repo: undefined,
									name: `${state.item.item.issue.id}-${state.item.item.issue.title}`,
									suggestNameOnly: true,
								},
							},
							this.pickedVia,
						);
						break;
				}
			}

			endSteps(state);
		}

		return state.counter < 0 ? StepResultBreak : undefined;
	}

	private async *confirmCloudIntegrationsConnectStep(
		state: StepState<State>,
		context: Context,
	): AsyncStepResultGenerator<{ connected: boolean | IntegrationId; resume: () => void }> {
		// TODO: This step is almost an exact copy of the similar one from launchpad.ts. Do we want to do anything about it? Maybe to move it to an util function with ability to parameterize labels?
		const hasConnectedIntegration = some(context.connectedIntegrations.values(), c => c);
		const step = this.createConfirmStep(
			`${this.title} \u00a0\u2022\u00a0 Connect an ${hasConnectedIntegration ? 'Additional ' : ''}Integration`,
			[
				createDirectiveQuickPickItem(Directive.Cancel, undefined, {
					label: 'Start Work lets you start work on an issue',
					detail: 'Click to learn more about Start Work',
					iconPath: new ThemeIcon('rocket'),
					onDidSelect: () =>
						// TODO: navigate to "start-work" related place
						void executeCommand<OpenWalkthroughCommandArgs>(Commands.OpenWalkthrough, {
							step: 'launchpad',
							source: 'launchpad',
							detail: 'info',
						}),
				}),
				createQuickPickSeparator(),
				createQuickPickItemOfT(
					{
						label: `Connect an ${hasConnectedIntegration ? 'Additional ' : ''}Integration...`,
						detail: hasConnectedIntegration
							? 'Connect additional integrations to view their issues in Start Work'
							: 'Connect an integration to accelerate your work',
						picked: true,
					},
					true,
				),
			],
			createDirectiveQuickPickItem(Directive.Cancel, false, { label: 'Cancel' }),
			{
				placeholder: hasConnectedIntegration
					? 'Connect additional integrations to Start Work'
					: 'Connect an integration to get started with Start Work',
				buttons: [],
				ignoreFocusOut: true,
			},
		);

		// Note: This is a hack to allow the quickpick to stay alive after the user finishes connecting the integration.
		// Otherwise it disappears.
		let freeze!: () => Disposable;
		let quickpick!: QuickPick<any>;
		step.onDidActivate = qp => {
			quickpick = qp;
			freeze = () => freezeStep(step, qp);
		};

		const selection: StepSelection<typeof step> = yield step;

		if (canPickStepContinue(step, state, selection)) {
			const previousPlaceholder = quickpick.placeholder;
			quickpick.placeholder = 'Connecting integrations...';
			quickpick.ignoreFocusOut = true;
			const resume = freeze();
			const connected = await this.container.integrations.connectCloudIntegrations(
				{ integrationIds: supportedStartWorkIntegrations },
				{
					source: 'startWork',
				},
			);
			quickpick.placeholder = previousPlaceholder;
			return { connected: connected, resume: () => resume[Symbol.dispose]() };
		}

		return StepResultBreak;
	}

	private *pickIssueStep(state: StepState<State>, context: Context): StepResultGenerator<StartWorkItem> {
		const buildIssueItem = (i: StartWorkItem) => {
			const buttons = [StartWorkQuickInputButton];
			return {
				label:
					i.item.issue.title.length > 60 ? `${i.item.issue.title.substring(0, 60)}...` : i.item.issue.title,
				// description: `${i.repoAndOwner}#${i.id}, by @${i.author}`,
				description: `\u00a0 ${i.item.issue.repository?.owner ?? ''}/${i.item.issue.repository?.repo ?? ''}#${
					i.item.issue.id
				} \u00a0`,
				detail: `      ${fromNow(i.item.issue.updatedDate)} by @${i.item.issue.author.name}`,
				buttons: buttons,
				iconPath: i.item.issue.author?.avatarUrl != null ? Uri.parse(i.item.issue.author.avatarUrl) : undefined,
				item: i,
			};
		};

		const getItems = (result: StartWorkResult) => {
			const items: QuickPickItemOfT<StartWorkItem>[] = [];

			if (result.items?.length) {
				items.push(...result.items.map(buildIssueItem));
			}

			return items;
		};

		function getItemsAndPlaceholder() {
			if (!context.result.items.length) {
				return {
					placeholder: 'No issues found. Start work anyway.',
					// TODO: items: [createCallbackQuickPickItem(() => startWork(null), undefined, { label: 'Start Work' })],
					items: [createDirectiveQuickPickItem(Directive.Cancel, undefined, { label: 'Start Work' })],
				};
			}

			return {
				placeholder: 'Choose an item to focus on',
				items: getItems(context.result),
			};
		}

		const { items, placeholder } = getItemsAndPlaceholder();

		const step = createPickStep({
			title: context.title,
			placeholder: placeholder,
			matchOnDescription: true,
			matchOnDetail: true,
			items: items,
			onDidClickItemButton: (_quickpick, button, { item }) => {
				if (button === StartWorkQuickInputButton) {
					this.startWork(state, item);
					return true;
				}
				return false;
			},
		});

		const selection: StepSelection<typeof step> = yield step;
		if (!canPickStepContinue(step, state, selection)) {
			return StepResultBreak;
		}
		const element = selection[0];
		return { ...element.item };
	}

	private *confirmStep(state: StartWorkStepState, _context: Context): StepResultGenerator<StartWorkAction> {
		const confirmations: (QuickPickItemOfT<StartWorkAction> | DirectiveQuickPickItem)[] = [
			createQuickPickSeparator(fromNow(state.item.item.issue.updatedDate)),
			createQuickPickItemOfT(
				{
					label: state.item.item.issue.title,
					description: `${state.item.item.issue.repository?.owner ?? ''}/${
						state.item.item.issue.repository?.repo ?? ''
					}#${state.item.item.issue.id}`,
					detail: state.item.item.issue.body ?? '',
					iconPath:
						state.item.item.issue.author?.avatarUrl != null
							? Uri.parse(state.item.item.issue.author.avatarUrl)
							: undefined,
					buttons: [StartWorkQuickInputButton],
				},
				'start',
			),
			createDirectiveQuickPickItem(Directive.Noop, false, { label: '' }),
			createQuickPickSeparator('Actions'),
			createQuickPickItemOfT(
				{
					label: 'Start Work...',
					detail: `Will start working on this issue`,
				},
				'start',
			),
		];

		const step = this.createConfirmStep(
			`Issue ${state.item.item.issue.repository?.owner ?? ''}/${state.item.item.issue.repository?.repo ?? ''}#${
				state.item.item.issue.id
			}`,
			confirmations,
			undefined,
			{
				placeholder: 'Choose an action to perform',
				onDidClickItemButton: (_quickpick, button, _item) => {
					switch (button) {
						case StartWorkQuickInputButton:
							if (isDirectiveQuickPickItem(_item)) return;
							this.startWork(state);
							return true;
					}
					return false;
				},
			},
		);

		const selection: StepSelection<typeof step> = yield step;
		return canPickStepContinue(step, state, selection) ? selection[0].item : StepResultBreak;
	}

	private startWork(state: PartialStepState<State>, item?: StartWorkItem) {
		state.action = 'start';
		if (item != null) {
			state.item = item;
		}
	}
}

async function updateContextItems(container: Container, context: Context) {
	context.result = {
		items:
			(await container.integrations.getMyIssues([HostingIntegrationId.GitHub]))?.map(i => ({
				item: i,
			})) ?? [],
	};
}
