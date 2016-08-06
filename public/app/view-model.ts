import { Injectable } from '@angular/core';
import { ApiClient } from './api-client';
import { CookieService } from 'angular2-cookie/core';
import { Observable } from 'rxjs/Observable';

export class User {
  _id:string;
  id:string;
  password:string;
  name:string;
  role:string;
  avatarUrl:string;
}

@Injectable()
export class ViewModel {
  constructor(
    private apiClient: ApiClient,
    private cookieService: CookieService
  ){
    console.log('view model created.');
  }

  private me: User;
  // private loadedObservable: Observable<User>;
  private isLoaded: boolean = false;

  read() {

  }

  // load(user:User):  Observable<User> {
  //
  // }

  public unload(): any {
    this.me = null;
  };

  public checkLogin(){
    let authToken = this.cookieService.getObject('auth_token');
    if (authToken) {
      if (this.me){
        return Observable.create(observer => {
          observer.next(this.me);
          observer.complete();
        });
      }
      else {
        return this.apiClient.getMyInfo();
      }
    }
    else {
      return Observable.throw('not login');
    }
  }

  randomString(length: number): string {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const numbers = '1234567890';
    const charset = letters + letters.toUpperCase() + numbers;

    const randomElement = array => {
      return array[Math.floor(Math.random() * array.length)];
    }

    let result: string = '';
    for (let i = 0; i < length; i++)
      result += randomElement(charset);
    return result;
  }
}

// export const VIEW_MODEL
