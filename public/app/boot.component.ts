import { Component } from '@angular/core';
import { ApiClient } from './api-client';
import { Router } from '@angular/router';

@Component({
  selector: 'boot',
  template: ''
})
export class BootComponent {
  constructor(private apiClient: ApiClient, private router: Router) {
    this.apiClient.getMyInfo()
      .subscribe(
        result => console.log(result),
        err => this.router.navigate(['/login'])
      );
  }
}
