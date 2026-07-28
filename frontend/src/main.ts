import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, withHashLocation } from '@angular/router';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { AppComponent } from './app/app.component';
import { routes } from './app/app.routes';

bootstrapApplication(AppComponent, {
  providers: [
    // hash location keeps deep links working when served as static files
    provideRouter(routes, withHashLocation()),
    provideHttpClient(withFetch()),
  ],
}).catch((err) => console.error(err));

