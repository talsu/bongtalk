import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { ApiClient } from './api-client';

class User {
  name:string;
}

@Component({
  selector : 'bongtalk-app',
  templateUrl : './app/login.component.html'
})
export class LoginComponent {
  constructor(private router: Router, private apiClient: ApiClient){}
  user:User = new User();

  usernameChanged(newValue:string) {
    console.log(newValue);
    this.user.name = newValue;
  }

  usernameKeypress($event){
    if ($event.keyCode == 13 && $event.key == 'Enter'){
      this.signInByGuest();
    }
  }

  signInByGuest() {
    this.apiClient.signInByGuest(this.user).subscribe(
      result => console.log(result),
      err => console.log(err)
    );
  }

  goSignIn() {
    this.router.navigate(['/signin']);
  }

  goSignUp() {
    this.router.navigate(['/signup']);
  }
}
