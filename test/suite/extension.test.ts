import * as assert from 'assert';
import * as vscode from 'vscode';

describe('Extension Test Suite', () => {
    vscode.window.showInformationMessage('Starting extension tests.');

    it('Extension should be present', () => {
        assert.ok(vscode.extensions.getExtension('imview.imview'));
    });

    it('Should activate extension', async () => {
        const ext = vscode.extensions.getExtension('imview.imview');
        if (ext) {
            await ext.activate();
            assert.ok(ext.isActive);
        }
    });

    it('Commands should be registered', async () => {
        const commands = await vscode.commands.getCommands(true);

        assert.ok(commands.includes('imview.refresh'));
        assert.ok(commands.includes('imview.addWatch'));
        assert.ok(commands.includes('imview.removeWatch'));
        assert.ok(commands.includes('imview.openInEditor'));
    });
});
