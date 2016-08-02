import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { ViewModel } from './view-model';

@Component({
    selector: 'boot',
    template: ''
})
export class BootComponent implements OnInit {
    constructor(
        private router: Router,
        private viewModel: ViewModel
    ) {}

    ngOnInit(){
        this.viewModel.checkLogin().subscribe(
            result => {
                this.viewModel.me = result;
                this.router.navigate(['/main']);
            },
            error => {
                console.log(error);
                this.router.navigate(['/login']);
            }
        );
    }
}
