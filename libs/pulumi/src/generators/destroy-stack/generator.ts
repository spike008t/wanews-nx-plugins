import { S3 } from '@aws-sdk/client-s3'
import { readProjectConfiguration, Tree, updateJson } from '@nrwl/devkit'
import execa from 'execa'
import path from 'path'
import { getStackInfo } from '../../helpers/get-pulumi-args'
import { CreateStackGeneratorSchema } from './schema'

const s3 = new S3({})

export default async function (
    tree: Tree,
    options: CreateStackGeneratorSchema,
) {
    if (!options.projectName) {
        throw new Error('No projectName')
    }

    const targetProjectConfig = readProjectConfiguration(
        tree,
        options.projectName,
    )

    const { backendUrl, stack } = getStackInfo(
        targetProjectConfig.root,
        options.environment,
        options.stack,
        options.configurationStackFormat,
    )

    // Currently only support S3 locks
    if (options.removeLock && backendUrl && backendUrl.startsWith('s3')) {
        const Bucket = backendUrl.replace('s3://', '')
        const locksResponse = await s3.listObjectsV2({
            Bucket,
            Prefix: `.pulumi/locks/${stack}`,
        })

        for (const lockObject of locksResponse.Contents || []) {
            console.log(`Deleting ${lockObject}`)
            await s3.deleteObject({
                Bucket,
                Key: `${lockObject.Key}`,
            })
        }
    }

    if (options.removePendingOperations) {
        const stateFile = `${targetProjectConfig.root}/${stack}-state.json`

        const pulumiExportArgs = [
            'stack',
            'export',
            '--stack',

            '--file',
            path.basename(stateFile),
        ]
        console.log(`> pulumi ${pulumiExportArgs.join(' ')}`)
        await execa('pulumi', pulumiExportArgs, {
            stdio: [process.stdin, process.stdout, process.stderr],
        })

        // remove the pending operations from the state
        updateJson(tree, stateFile, (state) => {
            if (
                !options.ignorePendingCreateOperations &&
                state.deployment.pending_operations
            ) {
                const createOperations =
                    state.deployment.pending_operations.filter(
                        (operation: { resource: string; type: string }) =>
                            operation.type === 'creating',
                    )
                if (createOperations.length > 0) {
                    tree.delete(stateFile)
                    console.error(createOperations)
                    throw new Error(
                        'There are pending create operations. Please remove them before destroying the stack',
                    )
                }
            }
            delete state.deployment.pending_operations
            return state
        })

        const pulumiImportArgs = [
            'stack',
            'import',
            '--stack',
            stack,
            '--file',
            path.basename(stateFile),
        ]
        console.log(`> pulumi ${pulumiImportArgs.join(' ')}`)
        await execa('pulumi', pulumiImportArgs, {
            stdio: [process.stdin, process.stdout, process.stderr],
        })

        tree.delete(stateFile)
    }

    if (options.refreshBeforeDestroy) {
        const pulumiRefreshArgs = [
            'refresh',
            '--stack',
            stack,
            ...(options.target
                ? options.target.map((target) => `--target=${target}`)
                : []),
        ]
        console.log(`> pulumi ${pulumiRefreshArgs.join(' ')}`)
        await execa('pulumi', pulumiRefreshArgs, {
            stdio: [process.stdin, process.stdout, process.stderr],
        })
    }

    // delete the resources in the stack
    const pulumiDestroyArgs = [
        'destroy',
        '--stack',
        stack,
        ...(options.target
            ? options.target.map((target) => `--target=${target}`)
            : []),
    ]
    console.log(`> pulumi ${pulumiDestroyArgs.join(' ')}`)
    await execa('pulumi', pulumiDestroyArgs, {
        stdio: [process.stdin, process.stdout, process.stderr],
    })

    if (options.removeStack) {
        // remove the stack
        const pulumiRemoveArgs = ['stack', 'rm', '--stack', stack]
        console.log(`> pulumi ${pulumiRemoveArgs.join(' ')}`)
        await execa('pulumi', pulumiRemoveArgs, {
            stdio: [process.stdin, process.stdout, process.stderr],
        })

        // remove the config
        if (backendUrl && backendUrl.startsWith('s3://')) {
            const Bucket = backendUrl.replace('s3://', '')
            console.log(
                `Deleting ${backendUrl}/.pulumi/config-backups/${stack}`,
            )
            await s3.deleteObject({
                Bucket,
                Key: `.pulumi/config-backups/${stack}`,
            })
        }
    }
}
