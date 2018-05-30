/* jshint esversion: 6, strict: true, node: true */

'use strict';
/**
 * @classdesc HandlerPattern is the prototype for all custom event handlers
 */
class HandlerPattern {
	
	/**
	 * Creates a HandlerPattern custom event handler object
	 * @param {./customServiceAPI.js~API} mnetAPI - the API instance for this handler
	 */
	constructor(mnetAPI) {
		this.myAPI=mnetAPI;
	}
	
	/****
	 * onMNETValueChange is invoked if a Bus value for one of the bound addresses is received
	 * 
	 */
	onMNETValueChange(field, oldValue, newValue) {
		throw new Error('IMPLEMENTATION MISSING.');
	} // onBusValueChange
	
	/****
	 * onHKValueChange is invoked if HomeKit is changing characteristic values
	 * 
	 */
	onHKValueChange(field, oldValue, newValue) {
		throw new Error('IMPLEMENTATION MISSING.');
		
	} // onHKValueChange
} // class	
	
module.exports = HandlerPattern;