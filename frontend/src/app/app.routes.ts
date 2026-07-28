import { Routes } from '@angular/router';
import { RecordsListComponent } from './records-list.component';
import { TrackDetailComponent } from './track-detail.component';

export const routes: Routes = [
  { path: '', component: RecordsListComponent },
  { path: 'track/:id', component: TrackDetailComponent },
  { path: '**', redirectTo: '' },
];

