import type { Command } from 'commander'
import chalk from 'chalk'
import Table from 'cli-table3'
import { createPeerList, deletePeerList, findPeerList, updatePeerList } from '../../../gateway/services/peer-lists.js'
import type { PeerListRecord } from '../../../gateway/store.js'
import { collect } from './policy-options.js'
import { isoOrNull, printJson, withGateway } from './shared.js'

function listJson(list: PeerListRecord) {
  return { id: list.id, name: list.name, description: list.description, peerIds: list.peerIds, createdAt: isoOrNull(list.createdAt) }
}

function splitPeers(values: string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean)
}

export function registerGatewayPeerListCommands(gateway: Command): void {
  const peerList = gateway.command('peer-list').description('Named seller lists that routing policies allow or block by reference')

  peerList.command('list')
    .description('List peer lists')
    .option('--json', 'print machine-readable JSON', false)
    .action((options: { json: boolean }, cmd: Command) => withGateway(cmd, ({ store }) => {
      const lists = store.listPeerLists()
      if (options.json) {
        printJson(lists.map(listJson))
        return
      }
      if (lists.length === 0) {
        console.log(chalk.dim('No peer lists. Create one with `antseed gateway peer-list create --name <name> --peer <peerId>`.'))
        return
      }
      const table = new Table({ head: ['Id', 'Name', 'Sellers', 'Description'] })
      for (const list of lists) table.push([list.id, list.name, String(list.peerIds.length), list.description ?? '-'])
      console.log(table.toString())
    }))

  peerList.command('show')
    .description('Show a peer list\'s sellers')
    .argument('<list>', 'peer list id or name')
    .option('--json', 'print machine-readable JSON', false)
    .action((ref: string, options: { json: boolean }, cmd: Command) => withGateway(cmd, ({ ctx }) => {
      const list = findPeerList(ctx, ref)
      if (options.json) {
        printJson(listJson(list))
        return
      }
      console.log(`${chalk.bold(list.name)} ${chalk.dim(list.id)}${list.description ? `  ${list.description}` : ''}`)
      if (list.peerIds.length === 0) console.log(chalk.dim('  (empty)'))
      for (const peer of list.peerIds) console.log(`  ${peer}`)
    }))

  peerList.command('create')
    .description('Create a peer list')
    .requiredOption('--name <name>', 'list name')
    .option('--description <text>', 'what the list is for')
    .option('--peer <peerId>', 'a seller to include (repeatable, or comma-separated)', collect)
    .option('--json', 'print machine-readable JSON', false)
    .action((options: { name: string; description?: string; peer?: string[]; json: boolean }, cmd: Command) => withGateway(cmd, ({ ctx, actor }) => {
      const list = createPeerList(ctx, actor, { name: options.name, description: options.description ?? null, peerIds: splitPeers(options.peer) })
      if (options.json) {
        printJson(listJson(list))
        return
      }
      console.log(chalk.green(`Created peer list ${list.id} (${list.name}) with ${list.peerIds.length} seller(s).`))
      console.log(chalk.dim(`Use it in a policy with --allow-list ${list.id} or --block-list ${list.id}.`))
    }))

  peerList.command('update')
    .description('Rename a peer list, change its description, or replace its sellers')
    .argument('<list>', 'peer list id or name')
    .option('--name <name>', 'new name')
    .option('--description <text>', 'new description ("" removes it)')
    .option('--peers <peerIds>', 'replace the sellers with this comma-separated list ("" empties it)')
    .option('--confirm-empty', 'save even if a policy that allows only this list would be left with no seller', false)
    .action((ref: string, options: { name?: string; description?: string; peers?: string; confirmEmpty: boolean }, cmd: Command) => withGateway(cmd, ({ ctx, actor }) => {
      const before = findPeerList(ctx, ref)
      if (options.name === undefined && options.description === undefined && options.peers === undefined) throw new Error('Nothing to change: pass --name, --description or --peers.')
      const list = updatePeerList(ctx, actor, before.id, {
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(options.description !== undefined ? { description: options.description || null } : {}),
        ...(options.peers !== undefined ? { peerIds: splitPeers([options.peers]) } : {}),
        confirmEmpty: options.confirmEmpty,
      })
      console.log(`Updated ${list.name} (${list.id}): ${list.peerIds.length} seller(s).`)
    }))

  for (const [name, adding] of [['add', true], ['remove', false]] as const) {
    peerList.command(name)
      .description(adding ? 'Add sellers to a peer list' : 'Remove sellers from a peer list')
      .argument('<list>', 'peer list id or name')
      .argument('<peerIds...>', 'seller peer ids')
      .option('--confirm-empty', 'save even if a policy that allows only this list would be left with no seller', false)
      .action((ref: string, peerIds: string[], options: { confirmEmpty: boolean }, cmd: Command) => withGateway(cmd, ({ ctx, actor }) => {
        const before = findPeerList(ctx, ref)
        const changed = splitPeers(peerIds).map((id) => id.toLowerCase().replace(/^0x/, ''))
        const next = adding
          ? [...before.peerIds, ...changed]
          : before.peerIds.filter((id) => !changed.includes(id))
        const list = updatePeerList(ctx, actor, before.id, { peerIds: next, confirmEmpty: options.confirmEmpty })
        console.log(`${list.name} (${list.id}) now has ${list.peerIds.length} seller(s).`)
      }))
  }

  peerList.command('delete')
    .description('Delete a peer list; policies that reference it stop matching its sellers')
    .argument('<list>', 'peer list id or name')
    .option('--confirm-empty', 'delete even if a policy that allows only this list would be left with no seller', false)
    .action((ref: string, options: { confirmEmpty: boolean }, cmd: Command) => withGateway(cmd, ({ ctx, actor }) => {
      const list = deletePeerList(ctx, actor, findPeerList(ctx, ref).id, { confirmEmpty: options.confirmEmpty })
      console.log(`Deleted peer list ${list.name} (${list.id}).`)
    }))
}
