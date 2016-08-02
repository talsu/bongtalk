import { Injectable } from '@angular/core';
import { ApiClient } from './api-client';
import { CookieService } from 'angular2-cookie/core';
import { Observable } from 'rxjs/Observable';

export class User {
    _id:string;
    id:string;
    name:string;
    role:string;
}

@Injectable()
export class ViewModel {
    constructor(
        private apiClient: ApiClient,
        private cookieService: CookieService
    ){
        console.log('view model created.');
    }

    public me: User;

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
}

// export const VIEW_MODEL
