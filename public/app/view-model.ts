import { Injectable } from '@angular/core';

export class User {
    _id:string;
    id:string;
    name:string;
    role:string;
}

@Injectable()
export class ViewModel {
    constructor(){
        console.log('view model created.');
    }

    public me: User;
}

// export const VIEW_MODEL
