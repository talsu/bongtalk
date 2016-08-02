import { Component, OnInit } from '@angular/core';
import { ApiClient } from './api-client';
import { Router } from '@angular/router';
import { CookieService } from 'angular2-cookie/core';
import { ViewModel } from './view-model';
import { Observable } from 'rxjs/Observable';

@Component({
    selector: 'boot',
    template: '',
    providers : [ CookieService ]
})
export class BootComponent implements OnInit {
    constructor(
        private apiClient: ApiClient,
        private router: Router,
        private cookieService: CookieService,
        private viewModel: ViewModel
    ) {}

    ngOnInit(){
        this.checkLogin().subscribe(
            result => {
                console.log(result);
                this.viewModel.me = result;
                this.router.navigate(['/main']);
            },
            error => {
                console.log(error);
                this.router.navigate(['/login']);
            }
        );
        // this.apiClient.getMyInfo()
        // .subscribe(
        //     result => console.log(result),
        //     err => this.router.navigate(['/login'])
        // );
    }

    checkLogin(){
        let authToken = this.cookieService.getObject('auth_token');
        if (authToken) {
            if (this.viewModel.me){
                return Observable.create(observer => {
                    observer.next(this.viewModel.me);
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
        //
        // return Observable.create(observer => {
        //     let authToken = this.cookieService.getObject('auth_token');
        //     if (authToken) {
        //         if (this.viewModel.me){
        //             observer.onNext(this.viewModel.me);
        //             observer.onCompleted();
        //         }
        //         else {
        //             this.apiClient.getMyInfo()
        //                 .subscribe(
        //                     result => observer.onNext(result),
        //                     err => observer.onError('not login'),
        //                     () => observer.onCompleted()
        //                 );
        //         }
        //     }
        //     else {
        //          observer.onError('not login');
        //          observer.onCompleted();
        //     }
        // });
        // let authToken = this.cookieService.getObject('auth_token');
        // if (authToken) {
        //     if (this.viewModel.me){
        //         // ok
        //     }
        //     else {
        //         this.apiClient.getMyInfo()
        //             .subscribe(
        //                 result => console.log(result),
        //                 err => this.router.navigate(['/login'])
        //             );
        //     }
        // }
        // else {
        //     this.router.navigate(['/login'])
        // }
    }
}
