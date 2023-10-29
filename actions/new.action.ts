import * as chalk from 'chalk';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as inquirer from 'inquirer';
import { Answers, Question } from 'inquirer';
import { join } from 'path';
import { CommandContext, CommandContextEntry } from '../commands';
import { defaultGitIgnore } from '../lib/configuration/defaults';
import {
  AbstractPackageManager,
  PackageManager,
  PackageManagerFactory,
} from '../lib/package-managers';
import { generateInput, generateSelect } from '../lib/questions/questions';
import { GitRunner } from '../lib/runners/git.runner';
import {
  AbstractCollection,
  Collection,
  CollectionFactory,
  SchematicOption,
} from '../lib/schematics';
import { EMOJIS, MESSAGES } from '../lib/ui';
import { normalizeToKebabOrSnakeCase } from '../lib/utils/formatting';
import { AbstractAction } from './abstract.action';

export class NewAction extends AbstractAction {
  public async handle(inputs: CommandContext, options: CommandContext) {
    const directoryOption = options.get<string>('directory');
    const isDryRunEnabled = options.get<boolean>('dry-run')?.value ?? false;

    await askForMissingInformation(inputs, options);
    await generateApplicationFiles(inputs, options).catch(exit);

    const shouldSkipInstall =
      options.get<boolean>('skip-install')?.value ?? false;
    const shouldSkipGit = options.get<boolean>('skip-git')?.value ?? false;
    const projectDirectory = getProjectDirectory(
      getApplicationNameInput(inputs),
      directoryOption,
    );

    if (!shouldSkipInstall) {
      await installPackages(options, isDryRunEnabled, projectDirectory);
    }
    if (!isDryRunEnabled) {
      if (!shouldSkipGit) {
        await initializeGitRepository(projectDirectory);
        await createGitIgnoreFile(projectDirectory);
      }

      printCollective();
    }
    process.exit(0);
  }
}

const getApplicationNameInput = (inputs: CommandContext) =>
  inputs.get<string>('name', true);

const getProjectDirectory = (
  applicationName: CommandContextEntry<string>,
  directoryOption: CommandContextEntry<string> | undefined,
): string => {
  return (
    directoryOption?.value || normalizeToKebabOrSnakeCase(applicationName.value)
  );
};

const askForMissingInformation = async (
  inputs: CommandContext,
  options: CommandContext,
) => {
  console.info(MESSAGES.PROJECT_INFORMATION_START);
  console.info();

  const prompt: inquirer.PromptModule = inquirer.createPromptModule();

  const nameInput = getApplicationNameInput(inputs);
  if (!nameInput.value) {
    const message = 'What name would you like to use for the new project?';
    const questions = [generateInput('name', message)('nest-app')];
    const answers: Answers = await prompt(questions as ReadonlyArray<Question>);
    replaceInputMissingInformation(inputs, answers);
  }

  const packageManagerInput = options.get<string>('packageManager');
  if (!packageManagerInput?.value) {
    const answers = await askForPackageManager();
    replaceInputMissingInformation(options, answers);
  }
};

const replaceInputMissingInformation = (
  inputs: CommandContext,
  answers: Answers,
): void => {
  inputs.forEachEntry((input) => {
    if (input.value === undefined) {
      const maybeInputAnswer = answers[input.name];
      inputs.set({
        name: input.name,
        value: maybeInputAnswer,
      });
    }
  });
};

const generateApplicationFiles = async (
  args: CommandContext,
  options: CommandContext,
) => {
  const collectionName =
    options.get<Collection>('collection')?.value || Collection.NESTJS;
  const collection: AbstractCollection =
    CollectionFactory.create(collectionName);

  const argsAndOptionStorage = new CommandContext();
  argsAndOptionStorage.mergeWith(args);
  argsAndOptionStorage.mergeWith(options);
  const schematicOptions: SchematicOption[] =
    mapSchematicOptions(argsAndOptionStorage);
  await collection.execute('application', schematicOptions);

  console.info();
};

const mapSchematicOptions = (storage: CommandContext): SchematicOption[] => {
  const excludedInputNames = ['skip-install'];
  const options: SchematicOption[] = [];
  storage.forEachEntry((commandStorageEntry) => {
    if (
      !excludedInputNames.includes(commandStorageEntry.name) &&
      commandStorageEntry.value !== undefined
    ) {
      options.push(
        new SchematicOption(
          commandStorageEntry.name,
          commandStorageEntry.value,
        ),
      );
    }
  });
  return options;
};

const installPackages = async (
  options: CommandContext,
  dryRunMode: boolean,
  installDirectory: string,
) => {
  const inputPackageManager = options.get<string>('packageManager', true).value;

  let packageManager: AbstractPackageManager;
  if (dryRunMode) {
    console.info();
    console.info(chalk.green(MESSAGES.DRY_RUN_MODE));
    console.info();
    return;
  }
  try {
    packageManager = PackageManagerFactory.create(inputPackageManager);
    await packageManager.install(installDirectory, inputPackageManager);
  } catch (error) {
    if (error && error.message) {
      console.error(chalk.red(error.message));
    }
  }
};

const askForPackageManager = async (): Promise<Answers> => {
  const questions: Question[] = [
    generateSelect('packageManager')(MESSAGES.PACKAGE_MANAGER_QUESTION)([
      PackageManager.NPM,
      PackageManager.YARN,
      PackageManager.PNPM,
    ]),
  ];
  const prompt = inquirer.createPromptModule();
  return await prompt(questions);
};

const initializeGitRepository = async (dir: string) => {
  const runner = new GitRunner();
  await runner.run('init', true, join(process.cwd(), dir)).catch(() => {
    console.error(chalk.red(MESSAGES.GIT_INITIALIZATION_ERROR));
  });
};

/**
 * Write a file `.gitignore` in the root of the newly created project.
 * `.gitignore` available in `@nestjs/schematics` cannot be published to
 * NPM (needs to be investigated).
 *
 * @param dir Relative path to the project.
 * @param content (optional) Content written in the `.gitignore`.
 *
 * @return Resolves when succeeds, or rejects with any error from `fn.writeFile`.
 */
const createGitIgnoreFile = (dir: string, content?: string) => {
  const fileContent = content || defaultGitIgnore;
  const filePath = join(process.cwd(), dir, '.gitignore');

  if (fileExists(filePath)) {
    return;
  }
  return fs.promises.writeFile(filePath, fileContent);
};

const printCollective = () => {
  const dim = print('dim');
  const yellow = print('yellow');
  const emptyLine = print();

  emptyLine();
  yellow(`Thanks for installing Nest ${EMOJIS.PRAY}`);
  dim('Please consider donating to our open collective');
  dim('to help us maintain this package.');
  emptyLine();
  emptyLine();
  print()(
    `${chalk.bold(`${EMOJIS.WINE}  Donate:`)} ${chalk.underline(
      'https://opencollective.com/nest',
    )}`,
  );
  emptyLine();
};

const print =
  (color: string | null = null) =>
  (str = '') => {
    const terminalCols = retrieveCols();
    const strLength = str.replace(/\u001b\[[0-9]{2}m/g, '').length;
    const leftPaddingLength = Math.floor((terminalCols - strLength) / 2);
    const leftPadding = ' '.repeat(Math.max(leftPaddingLength, 0));
    if (color) {
      str = (chalk as any)[color](str);
    }
    console.log(leftPadding, str);
  };

export const retrieveCols = () => {
  const defaultCols = 80;
  try {
    const terminalCols = execSync('tput cols', {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return parseInt(terminalCols.toString(), 10) || defaultCols;
  } catch {
    return defaultCols;
  }
};

const fileExists = (path: string) => {
  try {
    fs.accessSync(path);
    return true;
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return false;
    }

    throw err;
  }
};

export const exit = () => process.exit(1);
