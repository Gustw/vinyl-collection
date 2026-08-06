import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SyncStatusComponent } from './sync-status.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, SyncStatusComponent],
  // The sync warning sits outside the outlet so it survives navigation: an
  // unsaved change must not be hidden by moving to another page.
  template: `<app-sync-status /><router-outlet></router-outlet>`,
})
export class AppComponent {}
