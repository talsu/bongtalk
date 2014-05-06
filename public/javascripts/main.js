'use strict';

requirejs.config({
	// baseUrl: 'bower_components',
	paths:{
		underscore : '../bower_components/underscore/underscore',
		jquery : '../bower_components/jquery/dist/jquery',
		angular : '../bower_components/angular/angular',
		bootstrap : '../bower_components/bootstrap/dist/bootstrap'

	},
	shim:{
		'angular':{
			deps:['jquery'],
			exports:'angular'
		},
		'bootstrap':{
			deps:['jquery'],
			exports:'bootstrap'
		}
	}
});

requirejs(['underscore', 'jquery', 'angular'], 
	function(_, $, angular){
		$(document).ready(function(){
			angular.bootstrap(document);
		});
	});