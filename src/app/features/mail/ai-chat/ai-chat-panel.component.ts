import {
  Component,
  ChangeDetectionStrategy,
  inject,
  ViewChild,
  ElementRef,
  AfterViewChecked,
  output,
  HostListener,
  ChangeDetectorRef,
  NgZone,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { FormsModule } from '@angular/forms';
import { ChatStore } from '../../../store/chat.store';
import { UiStore } from '../../../store/ui.store';
import { AccountsStore } from '../../../store/accounts.store';
import { ElectronService } from '../../../core/services/electron.service';
import { ChatMessageComponent } from './chat-message.component';
import { ResizablePanelDirective } from '../resizable-panel.directive';

@Component({
  selector: 'app-ai-chat-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './ai-chat-panel.component.html',
  styleUrl: './ai-chat-panel.component.scss',
  imports: [MatButtonModule, MatTooltipModule, FormsModule, ChatMessageComponent, ResizablePanelDirective],
})
export class AiChatPanelComponent implements AfterViewChecked {
  protected readonly chatStore = inject(ChatStore);
  protected readonly uiStore = inject(UiStore);
  protected readonly accountsStore = inject(AccountsStore);
  private readonly electronService = inject(ElectronService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly ngZone = inject(NgZone);

  readonly sourceClicked = output<string>();  // emits xGmMsgId for navigation

  @ViewChild('messageList') messageListRef!: ElementRef<HTMLElement>;

  protected inputText = '';
  private shouldScrollToBottom = false;

  /** Up/Down arrow history: index into user messages (oldest=0). -1 = not cycling. */
  private historyIndex = -1;
  /** Draft text to restore when cycling Down past the most recent. */
  private draftBeforeHistory = '';

  constructor() {
    // Scroll the message list on every streamed token so the view follows in real time.
    this.electronService.onAiChatStream$
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        this.ngZone.run(() => {
          this.shouldScrollToBottom = true;
          this.cdr.markForCheck();
        });
      });

    // Scroll again after the stream ends and source cards are rendered.
    this.electronService.onAiChatDone$
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        this.ngZone.run(() => {
          this.shouldScrollToBottom = true;
          this.cdr.markForCheck();
        });
      });
  }

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
    if (this.uiStore.aiChatPanelOpen()) {
      this.uiStore.toggleAiChatPanel();
    } else if (this.chatStore.panelStatus() !== 'disabled') {
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
    const userMessages = this.getUserMessageContents();
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (userMessages.length === 0) {
        return;
      }
      if (this.historyIndex < 0) {
        this.draftBeforeHistory = this.inputText;
        this.historyIndex = userMessages.length - 1;
        this.inputText = userMessages[this.historyIndex];
      } else if (this.historyIndex > 0) {
        this.historyIndex -= 1;
        this.inputText = userMessages[this.historyIndex];
      }
      this.cdr.markForCheck();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (this.historyIndex < 0) {
        return;
      }
      this.historyIndex += 1;
      if (this.historyIndex >= userMessages.length) {
        this.historyIndex = -1;
        this.inputText = this.draftBeforeHistory;
      } else {
        this.inputText = userMessages[this.historyIndex];
      }
      this.cdr.markForCheck();
      return;
    }
    this.historyIndex = -1;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  private getUserMessageContents(): string[] {
    return this.chatStore
      .messages()
      .filter((message) => message.role === 'user')
      .map((message) => message.content);
  }

  sendMessage(): void {
    const question = this.inputText.trim();
    if (!question || this.chatStore.inputDisabled()) { return; }

    const accountId = this.accountsStore.activeAccountId();
    if (!accountId) { return; }

    this.inputText = '';
    this.historyIndex = -1;
    this.draftBeforeHistory = '';
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

  onPanelResized(width: number): void {
    this.uiStore.setAiChatPanelWidth(width);
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
