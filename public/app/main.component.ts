import { Component, Input, OnInit, OnDestroy } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { ROUTER_DIRECTIVES } from '@angular/router';

@Component({
    selector: 'main',
    template: `
    <h2>Main</h2>
    <router-outlet></router-outlet>
    `,
    directives: [ROUTER_DIRECTIVES]
})
export class MainComponent implements OnInit, OnDestroy {
    private sub: any;
    constructor(
        private route: ActivatedRoute
    ) {

    }
    ngOnInit(){
        console.log('main component init.');
        this.sub = this.route.params.subscribe( params => {
            console.log(params);
        });
    }
    ngOnDestroy(){
        console.log('main component destroy.');
        this.sub.unsubscribe();
    }
}
