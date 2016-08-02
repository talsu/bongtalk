import { Http, Response, Headers } from '@angular/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs/Observable';

@Injectable()
export class ApiClient {
    constructor(private http: Http) {
        console.log('api client created');
    }

    getMyInfo() : Observable<any> {
        return this.http.get("api/user")
        .map(this.extractData)
        .catch(this.handleError);
    }

    signInByGuest(user) : Observable<any> {
        let headers = new Headers({'Content-Type': 'application/json'});

        return this.http.post('api/signInByGuest', JSON.stringify({user:user}), {headers: headers})
        .map(this.extractData)
        .catch(this.handleError);
    }

    private extractData(res: Response) {
        let body = res.json();
        if (body.err) throw {message:body.err};
        return body.result || { };
    }

    private handleError(error: any) {
        // In a real world app, we might use a remote logging infrastructure
        // We'd also dig deeper into the error to get a better message
        let errMsg = (error.message) ? error.message :
        error.status ? `${error.status} - ${error.statusText}` : 'Server error';
        console.error(errMsg); // log to console instead
        return Observable.throw(errMsg);
    }
}
