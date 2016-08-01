'use strict';
/* App Module */
angular.module('bongtalkApp', [
    'ngRoute',
    'ngCookies',
    'ngAnimate',
    'ngDialog',
    'bongtalk.controllers',
    'bongtalk.filters'
])
    .config(['$routeProvider',
    function ($routeProvider) {
        $routeProvider
            .when('/', { templateUrl: 'partials/boot.html', controller: 'BootController' })
            .when('/main', { templateUrl: 'partials/main.html', controller: 'MainController' })
            .when('/main/:left', { templateUrl: 'partials/main.html', controller: 'MainController' })
            .when('/main/:left/:right', { templateUrl: 'partials/main.html', controller: 'MainController' })
            .when('/main/:left/:right/:param', { templateUrl: 'partials/main.html', controller: 'MainController' })
            .when('/login', { templateUrl: 'partials/login.html', controller: 'LoginController' })
            .when('/signout', { templateUrl: 'partials/boot.html', controller: 'SignOutController' })
            .when('/signin', { templateUrl: 'partials/signIn.html', controller: 'SignInController' })
            .when('/signup', { templateUrl: 'partials/signUp.html', controller: 'SignUpController' })
            .when('/test', { templateUrl: 'partials/test.html', controller: 'TestController' })
            .otherwise({ redirectTo: '/' });
    }])
    .run(['$window', '$rootScope', '$location', '$cookies', 'emitter', 'apiClient', 'viewmodel',
    function ($window, $rootScope, $location, $cookies, emitter, apiClient, viewmodel) {
        $rootScope.vm = viewmodel;
        $rootScope.goBack = function () {
            $window.history.back();
        };
        $rootScope.checkLogin = function (callback) {
            var authToken = $cookies.getObject('auth_token');
            if (authToken) {
                if ($rootScope.vm.data && $rootScope.vm.data.me) {
                    callback($rootScope.vm.data.me);
                }
                else {
                    apiClient.getMyInfo(function (err, result) {
                        if (err) {
                            $location.path('/login');
                        }
                        else {
                            callback(result);
                        }
                    });
                }
            }
            else {
                $location.path('/login');
            }
        };
    }]);
var bongtalkControllers = angular.module('bongtalk.controllers', []);
//# sourceMappingURL=app.module.js.map