/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as path from 'path'

import { collectFiles, getSourceCodePath, prepareRepoData } from '../util/files'
import { CodeGenState, ConversationNotStartedState, RefinementState } from './sessionState'
import type { Interaction, SessionState, SessionStateConfig } from '../types'
import { SessionConfig } from './sessionConfig'
import { ConversationIdNotFoundError } from '../errors'
import { weaverbirdScheme } from '../constants'
import { FileSystemCommon } from '../../srcShared/fs'
import { Messenger } from '../controllers/chat/messenger/messenger'
import { uploadCode } from '../util/upload'
import { WeaverbirdClient } from '../client/weaverbird'
import { approachRetryLimit, codeGenRetryLimit } from '../limits'

const fs = FileSystemCommon.instance

export class Session {
    private _state?: SessionState
    private task: string = ''
    private approach: string = ''
    private proxyClient: WeaverbirdClient
    private _conversationId?: string
    private _uploadId?: string
    private approachRetries: number
    private codeGenRetries: number

    constructor(public readonly config: SessionConfig, private messenger: Messenger, private readonly tabID: string) {
        this._state = new ConversationNotStartedState('', tabID)
        this.proxyClient = new WeaverbirdClient()

        this.approachRetries = approachRetryLimit
        this.codeGenRetries = codeGenRetryLimit
    }

    /**
     * setupConversation
     *
     * Starts a conversation with the backend and uploads the repo for the LLMs to be able to use it.
     */
    public async setupConversation() {
        this._conversationId = await this.proxyClient.createConversation()

        const repoRootPath = await getSourceCodePath(this.config.workspaceRoot, 'src')
        const { zipFileBuffer, zipFileChecksum } = await prepareRepoData(repoRootPath)

        const { uploadUrl, uploadId } = await this.proxyClient.createUploadUrl(this._conversationId, zipFileChecksum)
        this._uploadId = uploadId

        await uploadCode(uploadUrl, zipFileBuffer)
        this._state = new RefinementState(
            {
                ...this.getSessionStateConfig(),
                conversationId: this.conversationId,
            },
            '',
            this.tabID
        )
    }

    private getSessionStateConfig(): SessionStateConfig {
        return {
            llmConfig: this.config.llmConfig,
            workspaceRoot: this.config.workspaceRoot,
            backendConfig: this.config.backendConfig,
            proxyClient: this.proxyClient,
            conversationId: this.conversationId,
            uploadId: this.uploadId,
        }
    }

    /**
     * Triggered by the Write Code follow up button to move to the code generation phase
     */
    initCodegen(): void {
        this._state = new CodeGenState(
            {
                ...this.getSessionStateConfig(),
                conversationId: this.conversationId,
            },
            this.approach,
            this.tabID
        )
    }

    async send(msg: string): Promise<Interaction> {
        // When the task/"thing to do" hasn't been set yet, we want it to be the incoming message
        if (this.task === '') {
            this.task = msg
        }

        return this.nextInteraction(msg)
    }

    private async nextInteraction(msg: string | undefined) {
        const files = await collectFiles(this.config.workspaceRoot)

        const resp = await this.state.interact({
            files,
            task: this.task,
            msg,
            fs: this.config.fs,
            messenger: this.messenger,
        })

        if (resp.nextState) {
            // Approach may have been changed after the interaction
            const newApproach = this.state.approach

            // Cancel the request before moving to a new state
            this.state.tokenSource.cancel()

            // Move to the next state
            this._state = resp.nextState

            // If approach was changed then we need to set it in the next state and this state
            this.state.approach = newApproach
            this.approach = newApproach
        }

        return resp.interaction
    }

    public async acceptChanges() {
        for (const filePath of this.state.filePaths ?? []) {
            const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(this.config.workspaceRoot, filePath)

            const uri = vscode.Uri.from({ scheme: weaverbirdScheme, path: filePath })
            const content = await this.config.fs.readFile(uri)
            const decodedContent = new TextDecoder().decode(content)

            await fs.mkdir(path.dirname(absolutePath))
            await fs.writeFile(absolutePath, decodedContent)
        }
    }

    get state() {
        if (!this._state) {
            throw new Error("State should be initialized before it's read")
        }
        return this._state
    }

    get retries() {
        switch (this.state.phase) {
            case 'Approach':
                return this.approachRetries
            case 'Codegen':
                return this.codeGenRetries
            default:
                return this.approachRetries
        }
    }

    decreaseRetries() {
        switch (this.state.phase) {
            case 'Approach':
                this.approachRetries -= 1
                break
            case 'Codegen':
                this.codeGenRetries -= 1
                break
        }
    }
    get conversationId() {
        if (!this._conversationId) {
            throw new ConversationIdNotFoundError()
        }
        return this._conversationId
    }

    get uploadId() {
        if (!this._uploadId) {
            throw new Error("UploadId should be initialized before it's read")
        }
        return this._uploadId
    }
}
