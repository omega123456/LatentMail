import {
  Component,
  ChangeDetectionStrategy,
  inject,
  ViewChild,
  ElementRef,
  AfterViewChecked,
  output,
  HostListener,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { FormsModule } from '@angular/forms';
import { ChatStore } from '../../../store/chat.store';
import { UiStore } from '../../../store/ui.store';
import { AccountsStore } from '../../../store/accounts.store';
import { ChatMessageComponent } from './chat-message.component';

@Component({
  selector: 'app-ai-chat-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './ai-chat-panel.component.html',
  styleUrl: './ai-chat-panel.component.scss',
  imports: [MatButtonModule, MatTooltipModule, FormsModule, ChatMessageComponent],
})
export class AiChatPanelComponent implements AfterViewChecked {
  protected readonly chatStore = inject(ChatStore);
  protected readonly uiStore = inject(UiStore);
  protected readonly accountsStore = inject(AccountsStore);

  readonly sourceClicked = output<string>();  // emits xGmMsgId for navigation

  @ViewChild('messageList') messageListRef!: ElementRef<HTMLElement>;

  protected inputText = '';
  private shouldScrollToBottom = false;

  readonly examplePrompts = [
    'Summarize last week\'s important emails',
    'Find emails about budget or finance',
    'Who emailed me most recently?',
  ];

  ngAfterViewChecked(): void {
    if (this.shouldScrollToBottom) {
      this.scrollToBottom();
      this.shouldScrollToBottom = false;
    }
  }

  togglePanel(): void {
    if (!this.uiStore.aiChatPanelOpen()) {
      this.uiStore.toggleAiChatPanel();
    }
  }

  closePanel(): void {
    if (this.uiStore.aiChatPanelOpen()) {
      this.uiStore.toggleAiChatPanel();
    }
  }

  /**
   * Close the panel when Escape is pressed and stop the event from propagating
   * to the CommandRegistryService (which would otherwise clear the email selection).
   */
  @HostListener('document:keydown.escape', ['$event'])
  onEscapeKey(event: Event): void {
    if (this.uiStore.aiChatPanelOpen()) {
      event.stopPropagation();
      this.closePanel();
    }
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  sendMessage(): void {
    const question = this.inputText.trim();
    if (!question || this.chatStore.inputDisabled()) { return; }

    const accountId = this.accountsStore.activeAccountId();
    if (!accountId) { return; }

    this.inputText = '';
    this.shouldScrollToBottom = true;
    this.chatStore.sendMessage(question, accountId);
  }

  stopStream(): void {
    this.chatStore.cancelStream();
  }

  newChat(): void {
    void this.chatStore.newChat();
  }

  useExamplePrompt(prompt: string): void {
    this.inputText = prompt;
    this.sendMessage();
  }

  onSourceClicked(xGmMsgId: string): void {
    this.sourceClicked.emit(xGmMsgId);
  }

  onMessageTokenAdded(): void {
    this.shouldScrollToBottom = true;
  }

  private scrollToBottom(): void {
    const element = this.messageListRef?.nativeElement;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }
}
